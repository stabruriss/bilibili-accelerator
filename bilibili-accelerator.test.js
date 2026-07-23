'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./bilibili-accelerator.user.js');

const COS =
    'https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/01/23/video.m4s?deadline=1&token=a%2Fb+x&orderid=0&orderid=1';
const AKAMAI =
    'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/01/23/video.m4s?deadline=1&hdnts=st=1~exp=2~acl=%2F*~hmac=abc+def';
const AUDIO_COS =
    'https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/04/56/audio.m4s?deadline=1&token=audio';

function health(
    host,
    {
        now = Date.now(),
        ok = true,
        successes = 2,
        attempts = 2,
        worstMs = 250,
        mbps = 20,
        ttfb = 80,
        verifiedAt = now
    } = {}
) {
    return {
        host,
        ok,
        successes,
        attempts,
        worstMs,
        medianMbps: mbps,
        medianTtfbMs: ttfb,
        sampledAt: now,
        verifiedAt
    };
}

function dashEntry(base, backups = []) {
    return {
        id: 80,
        baseUrl: base,
        base_url: base,
        backupUrl: backups.slice(),
        backup_url: backups.slice()
    };
}

test('safeSwapHost preserves the signed suffix byte-for-byte', () => {
    const swapped = core.safeSwapHost(
        COS,
        'upos-sz-mirroraliov.bilivideo.com'
    );
    assert.equal(
        swapped,
        COS.replace(
            'upos-sz-mirrorcosov.bilivideo.com',
            'upos-sz-mirroraliov.bilivideo.com'
        )
    );
    assert.equal(
        core.safeSwapHost(COS, 'upos-hz-mirrorakam.akamaized.net'),
        null
    );
    assert.equal(
        core.safeSwapHost(
            AKAMAI,
            'upos-sz-mirrorcosov.bilivideo.com'
        ),
        null
    );
});

test('media observation ignores analytics URLs that merely mention a fragment', () => {
    assert.equal(core.isObservableMediaRequest(COS), true);
    assert.equal(core.isObservableMediaRequest(AKAMAI), true);
    assert.equal(
        core.isObservableMediaRequest(
            'https://data.bilibili.com/log?url=video.m4s'
        ),
        false
    );
});

test('Akamai-only entries never synthesize a generic CDN URL', () => {
    const now = Date.now();
    const entry = dashEntry(AKAMAI, []);
    const payload = {
        code: 0,
        data: { dash: { video: [entry], audio: [] } }
    };
    const records = {
        'upos-sz-mirrorcosov.bilivideo.com': health(
            'upos-sz-mirrorcosov.bilivideo.com',
            { now, worstMs: 100 }
        )
    };

    core.transformPlayInfo(payload, records, now);

    assert.equal(entry.baseUrl, AKAMAI);
    assert.deepEqual(entry.backupUrl, []);
});

test('an Akamai-first entry uses its exact bilivideo backup as donor', () => {
    const entry = dashEntry(AKAMAI, [COS]);
    const payload = {
        code: 0,
        data: { dash: { video: [entry], audio: [] } }
    };

    core.transformPlayInfo(payload, {}, Date.now(), {
        safeHosts: ['upos-sz-mirroraliov.bilivideo.com']
    });

    const ali = entry.backupUrl.find(
        url => core.hostOf(url) === 'upos-sz-mirroraliov.bilivideo.com'
    );
    assert.equal(
        ali,
        COS.replace(
            'upos-sz-mirrorcosov.bilivideo.com',
            'upos-sz-mirroraliov.bilivideo.com'
        )
    );
    assert.equal(ali.includes('hdnts='), false);
});

test('native Akamai can win without changing its signature string', () => {
    const now = Date.now();
    const entry = dashEntry(COS, [AKAMAI]);
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [entry],
                audio: [dashEntry(AUDIO_COS, [])]
            }
        }
    };
    const records = {
        [core.hostOf(COS)]: health(core.hostOf(COS), {
            now,
            worstMs: 900,
            mbps: 5
        }),
        [core.hostOf(AKAMAI)]: health(core.hostOf(AKAMAI), {
            now,
            worstMs: 220,
            mbps: 18
        })
    };

    const result = core.transformPlayInfo(payload, records, now, {
        safeHosts: ['upos-sz-mirrorcosov.bilivideo.com']
    });

    assert.equal(result.winnerHost, core.hostOf(AKAMAI));
    assert.equal(entry.baseUrl, AKAMAI);
    assert.equal(entry.base_url, AKAMAI);
    assert.ok(entry.backupUrl.includes(COS));
    assert.equal(
        entry.baseUrl,
        'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/01/23/video.m4s?deadline=1&hdnts=st=1~exp=2~acl=%2F*~hmac=abc+def'
    );

    // The audio track has no native Akamai URL, so it must not synthesize one.
    assert.equal(payload.data.dash.audio[0].baseUrl, AUDIO_COS);
    assert.equal(
        core
            .collectOriginals(payload.data.dash.audio[0])
            .some(url => core.isAkamaiHost(core.hostOf(url))),
        false
    );
});

test('manual generic target preserves the signed suffix and original chain', () => {
    const aliHost = 'upos-sz-mirroraliov.bilivideo.com';
    const expectedAli = COS.replace(core.hostOf(COS), aliHost);
    const entry = dashEntry(COS, [AKAMAI]);
    const payload = {
        code: 0,
        data: { dash: { video: [entry], audio: [] } }
    };

    const result = core.transformPlayInfo(payload, {}, Date.now(), {
        mode: 'manual',
        manualTarget: aliHost
    });

    assert.equal(result.changed, true);
    assert.equal(result.manualMatched, 1);
    assert.equal(result.manualMissed, 0);
    assert.equal(entry.baseUrl, expectedAli);
    assert.equal(entry.base_url, expectedAli);
    assert.equal(
        entry.baseUrl.slice(entry.baseUrl.indexOf('/upgcxcode/')),
        COS.slice(COS.indexOf('/upgcxcode/'))
    );
    assert.deepEqual(entry.backupUrl.slice(0, 2), [COS, AKAMAI]);
    assert.deepEqual(entry.backup_url, entry.backupUrl);
});

test('manual native Akamai accepts only an original hdnts URL', () => {
    const unsignedAkamai =
        'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/01/23/video.m4s?deadline=1&token=not-hdnts';
    const entry = dashEntry(COS, [unsignedAkamai, AKAMAI]);
    const payload = {
        code: 0,
        result: { dash: { video: [entry], audio: [] } }
    };

    const result = core.transformPlayInfo(payload, {}, Date.now(), {
        mode: 'manual',
        manualTarget: 'native-akamai'
    });

    assert.equal(result.manualMatched, 1);
    assert.equal(entry.baseUrl, AKAMAI);
    assert.equal(entry.base_url, AKAMAI);
    assert.match(entry.baseUrl, /[?&]hdnts=/);
    assert.equal(
        entry.baseUrl,
        'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/01/23/video.m4s?deadline=1&hdnts=st=1~exp=2~acl=%2F*~hmac=abc+def'
    );
    assert.deepEqual(entry.backupUrl.slice(0, 2), [COS, unsignedAkamai]);
    assert.deepEqual(entry.backup_url, entry.backupUrl);
});

test('manual native Akamai miss leaves an entry byte-for-byte unchanged', () => {
    const entry = dashEntry(COS, []);
    const payload = {
        code: 0,
        data: { dash: { video: [entry], audio: [] } }
    };
    const before = JSON.stringify(payload);

    const result = core.transformPlayInfo(payload, {}, Date.now(), {
        mode: 'manual',
        manualTarget: 'native-akamai'
    });

    assert.equal(result.changed, false);
    assert.equal(result.manualMatched, 0);
    assert.equal(result.manualMissed, 1);
    assert.equal(JSON.stringify(payload), before);
});

test('manual invalid target leaves the original entry unchanged', () => {
    for (const manualTarget of [
        'upos-hz-mirrorakam.akamaized.net',
        'evil.example',
        'https://upos-sz-mirrorcosov.bilivideo.com/path'
    ]) {
        const entry = dashEntry(COS, [AKAMAI]);
        const payload = {
            code: 0,
            data: { dash: { video: [entry], audio: [] } }
        };
        const before = JSON.stringify(payload);

        const result = core.transformPlayInfo(payload, {}, Date.now(), {
            mode: 'manual',
            manualTarget
        });

        assert.equal(result.changed, false, manualTarget);
        assert.equal(result.manualMatched, 0, manualTarget);
        assert.equal(result.manualMissed, 1, manualTarget);
        assert.equal(JSON.stringify(payload), before, manualTarget);
    }
});

test('manual Akamai match never crosses from video into audio', () => {
    const video = dashEntry(COS, [AKAMAI]);
    const audio = dashEntry(AUDIO_COS, []);
    const payload = {
        code: 0,
        data: { dash: { video: [video], audio: [audio] } }
    };
    const audioBefore = JSON.stringify(audio);

    const result = core.transformPlayInfo(payload, {}, Date.now(), {
        mode: 'manual',
        manualTarget: 'native-akamai'
    });

    assert.equal(result.manualMatched, 1);
    assert.equal(result.manualMissed, 1);
    assert.equal(video.baseUrl, AKAMAI);
    assert.equal(video.base_url, AKAMAI);
    assert.equal(JSON.stringify(audio), audioBefore);
    assert.equal(
        core
            .collectOriginals(audio)
            .some(url => core.isAkamaiHost(core.hostOf(url))),
        false
    );
    assert.equal(
        core.collectOriginals(audio).some(url => url.includes('/video.m4s')),
        false
    );
});

test('cold cache keeps Bilibili original base and adds synthetic fallbacks last', () => {
    const entry = dashEntry(COS, [AKAMAI]);
    const payload = { code: 0, result: { dash: { video: [entry] } } };

    core.transformPlayInfo(payload, {}, Date.now(), {
        safeHosts: [
            'upos-sz-mirrorcosov.bilivideo.com',
            'upos-sz-mirroraliov.bilivideo.com'
        ]
    });

    assert.equal(entry.baseUrl, COS);
    assert.deepEqual(entry.backupUrl.slice(0, 2), [
        AKAMAI,
        COS.replace(
            'upos-sz-mirrorcosov.bilivideo.com',
            'upos-sz-mirroraliov.bilivideo.com'
        )
    ]);
});

test('all fresh probe failures preserve only the exact original chain', () => {
    const now = Date.now();
    const entry = dashEntry(COS, [AKAMAI]);
    const payload = {
        code: 0,
        result: { video_info: { dash: { video: [entry] } } }
    };
    const records = {
        [core.hostOf(COS)]: health(core.hostOf(COS), {
            now,
            ok: false,
            successes: 0
        }),
        [core.hostOf(AKAMAI)]: health(core.hostOf(AKAMAI), {
            now,
            ok: false,
            successes: 0
        }),
        'upos-sz-mirroraliov.bilivideo.com': health(
            'upos-sz-mirroraliov.bilivideo.com',
            { now, ok: false, successes: 0 }
        )
    };

    core.transformPlayInfo(payload, records, now, {
        safeHosts: ['upos-sz-mirroraliov.bilivideo.com']
    });

    assert.equal(entry.baseUrl, COS);
    assert.deepEqual(entry.backupUrl, [AKAMAI]);
});

test('durl and nested durls are both transformed', () => {
    const now = Date.now();
    const ALI = COS.replace(
        'upos-sz-mirrorcosov.bilivideo.com',
        'upos-sz-mirroraliov.bilivideo.com'
    );
    const payload = {
        code: 0,
        result: {
            durl: [{ url: COS, backup_url: [AKAMAI] }],
            durls: [
                {
                    durl: [{ url: COS, backupUrl: [AKAMAI] }]
                }
            ]
        }
    };
    const records = {
        'upos-sz-mirroraliov.bilivideo.com': health(
            'upos-sz-mirroraliov.bilivideo.com',
            { now, worstMs: 180 }
        )
    };

    const result = core.transformPlayInfo(payload, records, now, {
        safeHosts: ['upos-sz-mirroraliov.bilivideo.com']
    });

    assert.equal(result.entryCount, 2);
    assert.equal(payload.result.durl[0].url, ALI);
    assert.equal(payload.result.durls[0].durl[0].url, ALI);
});

test('transforming twice is idempotent', () => {
    const now = Date.now();
    const entry = dashEntry(COS, [AKAMAI]);
    const payload = {
        code: 0,
        data: { dash: { video: [entry], audio: [] } }
    };
    const records = {
        [core.hostOf(COS)]: health(core.hostOf(COS), { now })
    };

    core.transformPlayInfo(payload, records, now);
    const once = JSON.stringify(payload);
    core.transformPlayInfo(payload, records, now);
    assert.equal(JSON.stringify(payload), once);
});

test('explicit PCDN is demoted behind official URLs', () => {
    const pcdn =
        'https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/01/23/video.m4s?os=mcdn';
    const entry = dashEntry(pcdn, [COS, AKAMAI]);
    const payload = { code: 0, data: { dash: { video: [entry] } } };

    core.transformPlayInfo(payload, {}, Date.now(), { safeHosts: [] });

    assert.equal(entry.baseUrl, COS);
    assert.equal(entry.backupUrl.at(-1), pcdn);
});

test('unsupported/error payloads remain untouched', () => {
    const payload = {
        code: -404,
        data: { dash: { video: [dashEntry(COS, [AKAMAI])] } }
    };
    const before = JSON.stringify(payload);
    const result = core.transformPlayInfo(payload, {}, Date.now());
    assert.equal(result.changed, false);
    assert.equal(JSON.stringify(payload), before);
});

test('settings normalization migrates the legacy switch and rejects unsafe routes', () => {
    assert.deepEqual(core.normalizeSettings(null, false), {
        version: 1,
        enabled: false,
        mode: 'auto',
        manualTarget: core.SAFE_GENERIC_HOSTS[0],
        autoProbe: true
    });
    assert.deepEqual(
        core.normalizeSettings({
            enabled: true,
            mode: 'manual',
            manualTarget: core.NATIVE_AKAMAI_ROUTE
        }),
        {
            version: 1,
            enabled: true,
            mode: 'manual',
            manualTarget: core.NATIVE_AKAMAI_ROUTE,
            autoProbe: true
        }
    );
    assert.equal(
        core.normalizeSettings({
            enabled: true,
            mode: 'auto',
            autoProbe: false
        }).autoProbe,
        false
    );
    assert.equal(
        core.normalizeSettings({
            enabled: true,
            mode: 'manual',
            manualTarget: 'evil.example'
        }).manualTarget,
        core.SAFE_GENERIC_HOSTS[0]
    );
});

test('probe ages use compact minute, hour, and day buckets', () => {
    const now = 2_000_000_000_000;
    assert.equal(core.formatProbeAge(now - 59_999, now), '刚刚');
    assert.equal(
        core.formatProbeAge(now - 12 * 60 * 1000, now),
        '12 分钟前'
    );
    assert.equal(
        core.formatProbeAge(now - 7 * 60 * 60 * 1000, now),
        '7 小时前'
    );
    assert.equal(
        core.formatProbeAge(now - 3 * 24 * 60 * 60 * 1000, now),
        '3 天前'
    );
});

test('launcher position stays fully inside the viewport', () => {
    assert.deepEqual(core.defaultUiPosition(1200, 900), {
        x: 1152,
        y: 798
    });
    assert.deepEqual(
        core.clampUiPosition({ x: -50, y: 2000 }, 1200, 900),
        {
            x: core.UI_VIEWPORT_MARGIN,
            y:
                900 -
                core.UI_LAUNCHER_SIZE -
                core.UI_VIEWPORT_MARGIN
        }
    );
    assert.deepEqual(
        core.clampUiPosition({ x: 500.6, y: 400.4 }, 1200, 900),
        { x: 501, y: 400 }
    );
    assert.deepEqual(core.clampUiPosition(null, 40, 40), {
        x: 5,
        y: 5
    });
    assert.deepEqual(
        core.clampUiPosition({ x: 0, y: 0 }, 300, 200, 100, 50),
        {
            x: 108,
            y: 58
        }
    );
    assert.deepEqual(core.clampUiPosition(null, 30, 30), {
        x: 0,
        y: 0
    });
});

test('launcher drag threshold preserves small movements as clicks', () => {
    assert.equal(
        core.pointerMovedBeyondThreshold(10, 10, 12, 14),
        false
    );
    assert.equal(
        core.pointerMovedBeyondThreshold(10, 10, 13, 14),
        true
    );
    assert.equal(
        core.pointerMovedBeyondThreshold(10, 10, 30, 10),
        true
    );
});

test('a partially failed two-range probe is not promoted', () => {
    const record = core.aggregateProbeSamples('cdn.example', [
        {
            ok: true,
            mbps: 20,
            ttfbMs: 80,
            totalMs: 180
        },
        {
            ok: false,
            mbps: 0,
            ttfbMs: 0,
            totalMs: 6500
        }
    ]);
    assert.equal(record.successes, 1);
    assert.equal(record.attempts, 2);
    assert.equal(record.ok, false);
});

test('successful and failed health records use different cache lifetimes', () => {
    const now = 2_000_000_000_000;
    const host = core.hostOf(COS);

    assert.equal(
        core.isFreshHealth(
            health(host, {
                now: now - core.HEALTH_TTL_MS + 1
            }),
            now
        ),
        true
    );
    assert.equal(
        core.isFreshHealth(
            health(host, {
                now: now - core.HEALTH_TTL_MS - 1
            }),
            now
        ),
        false
    );
    assert.equal(
        core.isFreshHealth(
            health(host, {
                now: now - core.FAILED_HEALTH_TTL_MS + 1,
                ok: false,
                successes: 0
            }),
            now
        ),
        true
    );
    assert.equal(
        core.isFreshHealth(
            health(host, {
                now: now - core.FAILED_HEALTH_TTL_MS - 1,
                ok: false,
                successes: 0
            }),
            now
        ),
        false
    );
});

test('light verification is due without extending the full benchmark', () => {
    const now = 2_000_000_000_000;
    const sampledAt = now - 2 * 60 * 60 * 1000;
    const record = health(core.hostOf(COS), {
        now: sampledAt,
        verifiedAt:
            now - core.HEALTH_VERIFY_INTERVAL_MS + 1
    });

    assert.equal(core.needsHealthVerification(record, now), false);
    record.verifiedAt =
        now - core.HEALTH_VERIFY_INTERVAL_MS;
    assert.equal(core.needsHealthVerification(record, now), true);

    const legacy = { ...record };
    delete legacy.verifiedAt;
    assert.equal(core.verifiedAtOf(legacy, now), sampledAt);
    assert.equal(core.needsHealthVerification(legacy, now), true);
    assert.equal(record.sampledAt, sampledAt);
});

test('light verification promotes failures and significant slowdowns to a full probe', () => {
    const record = health(core.hostOf(COS), {
        worstMs: 200
    });
    assert.equal(core.verificationLimitMs(record), 750);
    assert.equal(
        core.isVerificationAcceptable(
            { ok: true, totalMs: 750 },
            record
        ),
        true
    );
    assert.equal(
        core.isVerificationAcceptable(
            { ok: true, totalMs: 751 },
            record
        ),
        false
    );
    assert.equal(
        core.isVerificationAcceptable(
            { ok: false, totalMs: 100 },
            record
        ),
        false
    );
});

test('adaptive work verifies the actual preferred host and retests only stale failures', () => {
    const now = 2_000_000_000_000;
    const old = now - core.HEALTH_VERIFY_INTERVAL_MS - 1;
    const cosHost = core.hostOf(COS);
    const aliHost = core.SAFE_GENERIC_HOSTS[1];
    const hkHost = core.SAFE_GENERIC_HOSTS[2];
    const routes = [
        { host: cosHost, url: COS },
        {
            host: aliHost,
            url: COS.replace(cosHost, aliHost)
        },
        {
            host: hkHost,
            url: COS.replace(cosHost, hkHost)
        }
    ];
    const records = {
        [cosHost]: health(cosHost, {
            now: old,
            verifiedAt: old,
            worstMs: 300
        }),
        [aliHost]: health(aliHost, {
            now: old,
            verifiedAt: old,
            ok: false,
            successes: 0
        }),
        [hkHost]: health(hkHost, {
            now: old,
            verifiedAt: now,
            worstMs: 100
        })
    };

    const work = core.planProbeWork(
        routes,
        records,
        now,
        cosHost
    );
    assert.equal(work.kind, 'adaptive');
    assert.equal(work.verifyRoute.host, cosHost);
    assert.deepEqual(
        work.routes.map(route => route.host),
        [aliHost]
    );

    records[cosHost].verifiedAt = now;
    records[aliHost] = health(aliHost, {
        now: now - 5 * 60 * 1000,
        verifiedAt: now - 5 * 60 * 1000,
        ok: false,
        successes: 0
    });
    assert.equal(
        core.planProbeWork(
            routes,
            records,
            now,
            cosHost
        ).kind,
        'none'
    );
    assert.equal(
        core.planProbeWork(
            routes,
            records,
            now,
            cosHost,
            true
        ).kind,
        'full'
    );
});

test('probe planning reserves API-native and preset network slots', () => {
    const otherHost = 'upos-sz-mirror08c.bilivideo.com';
    const other = COS.replace(core.hostOf(COS), otherHost);
    const candidates = core.buildCandidates([other, AKAMAI]);
    const plan = core.planFromCandidates(candidates);

    assert.deepEqual(
        plan.map(route => route.host),
        [
            otherHost,
            core.hostOf(AKAMAI),
            ...core.SAFE_GENERIC_HOSTS
        ]
    );
    assert.equal(plan.length, core.MAX_PROBE_HOSTS);

    const deduped = core.planFromCandidates(
        core.buildCandidates([COS, AKAMAI])
    );
    assert.deepEqual(
        deduped.map(route => route.host),
        [
            core.hostOf(COS),
            core.hostOf(AKAMAI),
            core.SAFE_GENERIC_HOSTS[1],
            core.SAFE_GENERIC_HOSTS[2]
        ]
    );
});

test('probe planning retains a cached winner from a later API backup', () => {
    const now = 2_000_000_000_000;
    const firstHost = 'upos-sz-mirror08c.bilivideo.com';
    const secondHost = 'upos-sz-mirror08h.bilivideo.com';
    const winnerHost = 'upos-sz-mirrorcos.bilivideo.com';
    const first = COS.replace(core.hostOf(COS), firstHost);
    const second = COS.replace(core.hostOf(COS), secondHost);
    const winner = COS.replace(core.hostOf(COS), winnerHost);
    const entry = dashEntry(first, [second, winner, AKAMAI]);
    const payload = {
        code: 0,
        data: { dash: { video: [entry], audio: [] } }
    };
    const records = {
        [firstHost]: health(firstHost, {
            now,
            worstMs: 1_000
        }),
        [secondHost]: health(secondHost, {
            now,
            worstMs: 900
        }),
        [winnerHost]: health(winnerHost, {
            now,
            verifiedAt:
                now - core.HEALTH_VERIFY_INTERVAL_MS - 1,
            worstMs: 100
        }),
        [core.hostOf(AKAMAI)]: health(core.hostOf(AKAMAI), {
            now,
            worstMs: 800
        })
    };

    const result = core.transformPlayInfo(payload, records, now, {
        safeHosts: []
    });
    assert.equal(result.winnerHost, winnerHost);
    assert.ok(
        result.probePlan.some(route => route.host === winnerHost)
    );

    const work = core.planProbeWork(
        result.probePlan,
        records,
        now,
        result.winnerHost
    );
    assert.equal(work.kind, 'adaptive');
    assert.equal(work.verifyRoute.host, winnerHost);
});

function fakeBrowserRoot(payload, settings = null) {
    const now = Date.now();
    const hosts = [
        'upos-sz-mirrorcosov.bilivideo.com',
        'upos-hz-mirrorakam.akamaized.net',
        'upos-sz-mirroraliov.bilivideo.com',
        'cn-hk-eq-01-03.bilivideo.com'
    ];
    const cache = {
        version: 1,
        health: Object.fromEntries(
            hosts.map((host, index) => [
                host,
                health(host, {
                    now,
                    worstMs: 200 + index * 200,
                    mbps: 20 - index
                })
            ])
        )
    };
    const storage = new Map([
        ['kota.biliAutoCdn.health.v1', JSON.stringify(cache)]
    ]);
    if (settings) {
        storage.set(
            'kota.biliAutoCdn.settings.v1',
            JSON.stringify(settings)
        );
    }

    class FakeXHR {
        constructor() {
            this.readyState = 0;
            this.responseType = '';
            this._responseText = '';
        }

        open(_method, url) {
            this._url = url;
        }

        get responseText() {
            return this._responseText;
        }

        get response() {
            return this.responseType === 'json'
                ? JSON.parse(this._responseText)
                : this._responseText;
        }
    }

    const root = {
        fetch: async () =>
            new Response(JSON.stringify(structuredClone(payload)), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            }),
        XMLHttpRequest: FakeXHR,
        Response,
        Headers,
        AbortController,
        JSON,
        performance,
        console: { info() {} },
        document: undefined,
        location: {
            href: 'https://www.bilibili.com/video/BV1test',
            reload() {}
        },
        localStorage: {
            getItem(key) {
                return storage.get(key) ?? null;
            },
            setItem(key, value) {
                storage.set(key, String(value));
            },
            removeItem(key) {
                storage.delete(key);
            }
        },
        setTimeout,
        clearTimeout,
        addEventListener() {}
    };

    return { root, FakeXHR, storage };
}

function prepareProbeBrowser(root) {
    root.document = {
        hidden: false,
        documentElement: null,
        querySelector(selector) {
            return selector === 'video'
                ? {
                      paused: true,
                      seeking: false,
                      readyState: 4
                  }
                : null;
        }
    };
    const nativeSetTimeout = setTimeout;
    root.setTimeout = (callback, milliseconds, ...args) =>
        nativeSetTimeout(
            callback,
            Math.min(Number(milliseconds) || 0, 5),
            ...args
        );
    return nativeSetTimeout;
}

function ageHealthCache(storage, ageMs, legacy = false) {
    const key = 'kota.biliAutoCdn.health.v1';
    const cache = JSON.parse(storage.get(key));
    const sampledAt = Date.now() - ageMs;
    for (const record of Object.values(cache.health)) {
        record.sampledAt = sampledAt;
        if (legacy) {
            delete record.verifiedAt;
        } else {
            record.verifiedAt = sampledAt;
        }
    }
    storage.set(key, JSON.stringify(cache));
    return sampledAt;
}

async function waitForProbeIdle(root, requestLog, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (
            requestLog.length &&
            root.__BiliAutoCDN &&
            !root.__BiliAutoCDN.status().probing
        ) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('probe did not finish before timeout');
}

test('browser shell rewrites playurl fetch and XHR getter responses', async () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(AKAMAI, [COS])],
                audio: []
            }
        }
    };
    const { root } = fakeBrowserRoot(payload);
    core.install(root);

    const api =
        'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1test&cid=1';
    const fetched = await (await root.fetch(api)).json();
    assert.equal(fetched.data.dash.video[0].baseUrl, COS);
    assert.equal(fetched.data.dash.video[0].backupUrl[0], AKAMAI);

    const xhr = new root.XMLHttpRequest();
    xhr.open('GET', api);
    xhr._responseText = JSON.stringify(structuredClone(payload));
    xhr.readyState = 4;
    const fromXhr = JSON.parse(xhr.responseText);
    assert.equal(fromXhr.data.dash.video[0].baseUrl, COS);
    assert.equal(fromXhr.data.dash.video[0].backupUrl[0], AKAMAI);

    const jsonXhr = new root.XMLHttpRequest();
    jsonXhr.open('GET', api);
    jsonXhr._responseText = JSON.stringify(structuredClone(payload));
    jsonXhr.responseType = 'json';
    jsonXhr.readyState = 4;
    assert.equal(jsonXhr.response.data.dash.video[0].baseUrl, COS);
});

test('browser shell performs one light Range without extending the full cache', async () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(COS, [AKAMAI])],
                audio: []
            }
        }
    };
    const { root, storage } = fakeBrowserRoot(payload);
    const sampledAt = ageHealthCache(
        storage,
        core.HEALTH_VERIFY_INTERVAL_MS + 1000,
        true
    );
    prepareProbeBrowser(root);
    const requests = [];
    root.fetch = async (input, init) => {
        if (init?.headers?.Range) {
            requests.push({
                url: String(input),
                range: init.headers.Range
            });
            return new Response(new Uint8Array(256 * 1024), {
                status: 206
            });
        }
        return new Response('{}', { status: 200 });
    };

    core.install(root);
    root.__playinfo__ = structuredClone(payload);
    await waitForProbeIdle(root, requests);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.includes(core.hostOf(COS)), true);
    assert.equal(requests[0].range, 'bytes=0-262143');
    const saved = JSON.parse(
        storage.get('kota.biliAutoCdn.health.v1')
    ).health[core.hostOf(COS)];
    assert.equal(saved.sampledAt, sampledAt);
    assert.ok(saved.verifiedAt > sampledAt);
});

test('automatic testing can be off while a manual retest still runs', async () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(COS, [AKAMAI])],
                audio: []
            }
        }
    };
    const { root, storage } = fakeBrowserRoot(payload, {
        version: 1,
        enabled: true,
        mode: 'auto',
        manualTarget: core.SAFE_GENERIC_HOSTS[0],
        autoProbe: false
    });
    storage.delete('kota.biliAutoCdn.health.v1');
    prepareProbeBrowser(root);
    const requests = [];
    root.fetch = async (input, init) => {
        if (init?.headers?.Range) {
            requests.push(String(input));
        }
        return new Response('{}', { status: 200 });
    };

    core.install(root);
    root.__playinfo__ = structuredClone(payload);
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.deepEqual(requests, []);
    assert.equal(root.__BiliAutoCDN.status().autoProbe, false);
    assert.equal(root.__BiliAutoCDN.status().probing, false);
    assert.equal(root.__BiliAutoCDN.retest(), true);
    await waitForProbeIdle(root, requests);
    assert.ok(requests.length > 0);
});

test('automatic testing requeues after a rapid off-on cycle', async () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(COS, [AKAMAI])],
                audio: []
            }
        }
    };
    const { root, storage } = fakeBrowserRoot(payload, {
        version: 1,
        enabled: true,
        mode: 'auto',
        manualTarget: core.SAFE_GENERIC_HOSTS[0],
        autoProbe: true
    });
    storage.delete('kota.biliAutoCdn.health.v1');
    prepareProbeBrowser(root);

    let markFirstStarted;
    const firstStarted = new Promise(resolve => {
        markFirstStarted = resolve;
    });
    let releaseFirst;
    const firstRelease = new Promise(resolve => {
        releaseFirst = resolve;
    });
    const requests = [];
    root.fetch = async (input, init) => {
        if (init?.headers?.Range) {
            requests.push(String(input));
            if (requests.length === 1) {
                markFirstStarted();
                await firstRelease;
            }
            return new Response(new Uint8Array(256 * 1024), {
                status: 206
            });
        }
        return new Response('{}', { status: 200 });
    };

    core.install(root);
    root.__playinfo__ = structuredClone(payload);
    await firstStarted;
    assert.equal(root.__BiliAutoCDN.setAutoProbe(false), true);
    assert.equal(root.__BiliAutoCDN.setAutoProbe(true), true);
    releaseFirst();
    await waitForProbeIdle(root, requests);

    assert.ok(requests.length > 1);
    assert.equal(root.__BiliAutoCDN.status().autoProbe, true);
    assert.equal(root.__BiliAutoCDN.status().probing, false);
});

test('an expired failed alternative is retested without rebenchmarking healthy routes', async () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(COS, [AKAMAI])],
                audio: []
            }
        }
    };
    const { root, storage } = fakeBrowserRoot(payload);
    ageHealthCache(
        storage,
        core.HEALTH_VERIFY_INTERVAL_MS + 1000
    );
    const cacheKey = 'kota.biliAutoCdn.health.v1';
    const cache = JSON.parse(storage.get(cacheKey));
    const aliHost = core.SAFE_GENERIC_HOSTS[1];
    cache.health[aliHost].ok = false;
    cache.health[aliHost].successes = 0;
    for (const [host, record] of Object.entries(cache.health)) {
        if (host !== core.hostOf(COS) && host !== aliHost) {
            record.verifiedAt = Date.now();
        }
    }
    storage.set(cacheKey, JSON.stringify(cache));
    prepareProbeBrowser(root);
    const requests = [];
    root.fetch = async (input, init) => {
        if (init?.headers?.Range) {
            requests.push({
                host: core.hostOf(String(input)),
                range: init.headers.Range
            });
            return new Response(new Uint8Array(256 * 1024), {
                status: 206
            });
        }
        return new Response('{}', { status: 200 });
    };

    core.install(root);
    root.__playinfo__ = structuredClone(payload);
    await waitForProbeIdle(root, requests);

    assert.deepEqual(
        requests.map(request => request.host),
        [core.hostOf(COS), aliHost, aliHost]
    );
    assert.deepEqual(
        requests.map(request => request.range),
        [
            'bytes=0-262143',
            'bytes=0-262143',
            'bytes=1048576-1310719'
        ]
    );
});

test('failed light verification escalates to one complete benchmark', async () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(COS, [AKAMAI])],
                audio: []
            }
        }
    };
    const { root, storage } = fakeBrowserRoot(payload);
    ageHealthCache(
        storage,
        core.HEALTH_VERIFY_INTERVAL_MS + 1000
    );
    prepareProbeBrowser(root);
    const requests = [];
    root.fetch = async (input, init) => {
        if (init?.headers?.Range) {
            requests.push({
                url: String(input),
                range: init.headers.Range
            });
            if (requests.length === 1) {
                return new Response('', { status: 503 });
            }
            return new Response(new Uint8Array(256 * 1024), {
                status: 206
            });
        }
        return new Response('{}', { status: 200 });
    };

    core.install(root);
    root.__playinfo__ = structuredClone(payload);
    await waitForProbeIdle(root, requests);

    // One quick Range, then two complete Ranges for the four deduplicated
    // routes: API Cosov, native Akamai, Aliov and Hong Kong EQ.
    assert.equal(requests.length, 1 + 2 * 4);
    assert.equal(root.__BiliAutoCDN.status().phase, 'ready');
});

test('persisted original mode leaves intercepted playurl responses untouched', async () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(AKAMAI, [COS])],
                audio: []
            }
        }
    };
    const { root } = fakeBrowserRoot(payload, {
        version: 1,
        enabled: false,
        mode: 'auto',
        manualTarget: core.SAFE_GENERIC_HOSTS[0]
    });
    core.install(root);

    const api =
        'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1test&cid=1';
    const fetched = await (await root.fetch(api)).json();
    assert.equal(fetched.data.dash.video[0].baseUrl, AKAMAI);
    assert.deepEqual(fetched.data.dash.video[0].backupUrl, [COS]);
    assert.equal(root.__BiliAutoCDN.status().enabled, false);
});

test('a safe manual route can re-enable the script from Bilibili original mode', () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(AKAMAI, [COS])],
                audio: []
            }
        }
    };
    const { root, storage } = fakeBrowserRoot(payload, {
        version: 1,
        enabled: false,
        mode: 'auto',
        manualTarget: core.SAFE_GENERIC_HOSTS[0],
        autoProbe: false
    });
    core.install(root);

    assert.equal(root.__BiliAutoCDN.setAutoProbe(false), true);
    assert.equal(root.__BiliAutoCDN.status().phase, 'off');
    assert.equal(
        root.__BiliAutoCDN.setMode(
            'manual',
            core.SAFE_GENERIC_HOSTS[1]
        ),
        true
    );
    assert.deepEqual(
        {
            enabled: root.__BiliAutoCDN.status().enabled,
            mode: root.__BiliAutoCDN.status().mode,
            manualTarget: root.__BiliAutoCDN.status().manualTarget,
            autoProbe: root.__BiliAutoCDN.status().autoProbe
        },
        {
            enabled: true,
            mode: 'manual',
            manualTarget: core.SAFE_GENERIC_HOSTS[1],
            autoProbe: false
        }
    );
    assert.equal(
        JSON.parse(
            storage.get('kota.biliAutoCdn.settings.v1')
        ).autoProbe,
        false
    );
});

test('persisted manual Akamai mode applies through fetch interception', async () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(COS, [AKAMAI])],
                audio: []
            }
        }
    };
    const { root } = fakeBrowserRoot(payload, {
        version: 1,
        enabled: true,
        mode: 'manual',
        manualTarget: core.NATIVE_AKAMAI_ROUTE,
        autoProbe: false
    });
    core.install(root);

    const api =
        'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1test&cid=1';
    const fetched = await (await root.fetch(api)).json();
    assert.equal(fetched.data.dash.video[0].baseUrl, AKAMAI);
    assert.equal(root.__BiliAutoCDN.status().mode, 'manual');
});

test('manual routing can keep automatic health testing enabled', async () => {
    const payload = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(COS, [AKAMAI])],
                audio: []
            }
        }
    };
    const manualTarget = core.SAFE_GENERIC_HOSTS[1];
    const { root, storage } = fakeBrowserRoot(payload, {
        version: 1,
        enabled: true,
        mode: 'manual',
        manualTarget,
        autoProbe: true
    });
    storage.delete('kota.biliAutoCdn.health.v1');
    prepareProbeBrowser(root);
    const requests = [];
    root.fetch = async (input, init) => {
        if (init?.headers?.Range) {
            requests.push(String(input));
            return new Response(new Uint8Array(256 * 1024), {
                status: 206
            });
        }
        return new Response('{}', { status: 200 });
    };

    core.install(root);
    root.__playinfo__ = structuredClone(payload);
    await waitForProbeIdle(root, requests);

    assert.ok(requests.length > 0);
    assert.equal(
        core.hostOf(root.__playinfo__.data.dash.video[0].baseUrl),
        manualTarget
    );
    assert.equal(root.__BiliAutoCDN.status().mode, 'manual');
    assert.equal(root.__BiliAutoCDN.status().autoProbe, true);
});

test('a newer SPA playurl invalidates the old pending probe plan', async () => {
    const firstUrl = COS.replace('video.m4s', 'video-a.m4s');
    const secondUrl = COS.replace('video.m4s', 'video-b.m4s');
    const first = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(firstUrl, [])],
                audio: []
            }
        }
    };
    const second = {
        code: 0,
        data: {
            dash: {
                video: [dashEntry(secondUrl, [])],
                audio: []
            }
        }
    };
    const { root } = fakeBrowserRoot(first);
    root.localStorage.removeItem('kota.biliAutoCdn.health.v1');
    root.document = {
        hidden: false,
        documentElement: null,
        querySelector(selector) {
            return selector === 'video'
                ? {
                      paused: true,
                      seeking: false,
                      readyState: 4
                  }
                : null;
        }
    };
    const nativeSetTimeout = setTimeout;
    root.setTimeout = (callback, milliseconds, ...args) =>
        nativeSetTimeout(
            callback,
            Math.min(Number(milliseconds) || 0, 5),
            ...args
        );
    const probedUrls = [];
    root.fetch = async (input, init) => {
        if (init?.headers?.Range) {
            probedUrls.push(String(input));
            return new Response(new Uint8Array(256 * 1024), {
                status: 206
            });
        }
        return new Response('{}', { status: 200 });
    };

    core.install(root);
    root.__playinfo__ = structuredClone(first);
    root.__playinfo__ = structuredClone(second);
    await new Promise(resolve => nativeSetTimeout(resolve, 120));

    assert.ok(probedUrls.length > 0);
    assert.equal(
        probedUrls.every(url => url.includes('video-b.m4s')),
        true
    );
    assert.equal(root.__BiliAutoCDN.status().probing, false);
});
