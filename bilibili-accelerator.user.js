// ==UserScript==
// @name         Bilibili Accelerator
// @name:zh-CN   Bilibili Accelerator
// @namespace    https://github.com/stabruriss/bilibili-accelerator
// @version      0.2.5
// @description  Test real signed video ranges in the background, then safely reorder Bilibili's native CDN URLs without forging Akamai signatures.
// @description:zh-CN 后台实测当前视频的真实签名分片，安全重排主备 CDN；不伪造 Akamai 签名，不制造并发取消风暴。
// @author       stabruriss
// @license      MIT
// @homepageURL  https://github.com/stabruriss/bilibili-accelerator
// @supportURL   https://github.com/stabruriss/bilibili-accelerator/issues
// @downloadURL  https://raw.githubusercontent.com/stabruriss/bilibili-accelerator/main/bilibili-accelerator.user.js
// @updateURL    https://raw.githubusercontent.com/stabruriss/bilibili-accelerator/main/bilibili-accelerator.user.js
// @match        https://www.bilibili.com/*
// @match        https://m.bilibili.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function bootstrap(root, factory) {
    'use strict';

    const core = factory();

    // Keeping the core importable makes URL/signature handling testable with
    // Node without executing the browser hooks.
    if (
        typeof module === 'object' &&
        module.exports &&
        typeof process === 'object' &&
        process.versions?.node
    ) {
        module.exports = core;
        return;
    }

    core.install(root);
})(
    typeof unsafeWindow !== 'undefined' ? unsafeWindow : globalThis,
    function createBiliAutoCdn() {
        'use strict';

        const VERSION = '0.2.5';
        const CACHE_VERSION = 1;
        const CACHE_KEY = 'kota.biliAutoCdn.health.v1';
        const ENABLED_KEY = 'kota.biliAutoCdn.enabled';
        const SETTINGS_KEY = 'kota.biliAutoCdn.settings.v1';
        const UI_POSITION_KEY = 'kota.biliAutoCdn.uiPosition.v1';
        const NATIVE_AKAMAI_ROUTE = 'native-akamai';
        const HEALTH_TTL_MS = 4 * 60 * 60 * 1000;
        const FAILED_HEALTH_TTL_MS = 15 * 60 * 1000;
        const HEALTH_VERIFY_INTERVAL_MS = 15 * 60 * 1000;
        const PROBE_DELAY_MS = 1200;
        const PROBE_TIMEOUT_MS = 6500;
        const PROBE_BYTES = 256 * 1024;
        const PROBE_RANGES = Object.freeze([
            [0, PROBE_BYTES - 1],
            [1024 * 1024, 1024 * 1024 + PROBE_BYTES - 1]
        ]);
        const VERIFY_SLOW_MIN_MS = 750;
        const VERIFY_SLOW_FACTOR = 3;
        const MAX_PROBE_HOSTS = 5;
        const MAX_ORIGINAL_PROBE_HOSTS = 2;
        const MAX_PRESET_PROBE_HOSTS = 3;
        const UI_LAUNCHER_SIZE = 30;
        const UI_VIEWPORT_MARGIN = 8;
        const UI_DRAG_THRESHOLD_PX = 5;

        // These are generic UPOS targets verified to accept an ordinary signed
        // bilivideo URL. Akamai is deliberately absent: it needs an API-native
        // hdnts URL and may never be synthesized by swapping a hostname.
        const SAFE_GENERIC_HOSTS = Object.freeze([
            'upos-sz-mirrorcosov.bilivideo.com',
            'upos-sz-mirroraliov.bilivideo.com',
            'cn-hk-eq-01-03.bilivideo.com'
        ]);

        const DEFAULT_SETTINGS = Object.freeze({
            version: 1,
            enabled: true,
            mode: 'auto',
            manualTarget: SAFE_GENERIC_HOSTS[0],
            autoProbe: true
        });

        function normalizeSettings(value, legacyEnabled = true) {
            const input =
                value && typeof value === 'object' ? value : {};
            const mode = input.mode === 'manual' ? 'manual' : 'auto';
            const allowedManualTargets = [
                NATIVE_AKAMAI_ROUTE,
                ...SAFE_GENERIC_HOSTS
            ];
            return {
                version: DEFAULT_SETTINGS.version,
                enabled:
                    typeof input.enabled === 'boolean'
                        ? input.enabled
                        : !!legacyEnabled,
                mode,
                manualTarget: allowedManualTargets.includes(
                    input.manualTarget
                )
                    ? input.manualTarget
                    : DEFAULT_SETTINGS.manualTarget,
                autoProbe:
                    typeof input.autoProbe === 'boolean'
                        ? input.autoProbe
                        : DEFAULT_SETTINGS.autoProbe
            };
        }

        const PLAYURL_PATHS = new Set([
            '/x/player/wbi/playurl',
            '/x/player/playurl',
            '/pgc/player/web/v2/playurl',
            '/pgc/player/web/playurl',
            '/pugv/player/web/playurl'
        ]);

        const MEDIA_PATH_RE = /\.(?:m4s|mp4|flv|m3u8)(?:$|[?#])/i;
        const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
        const PCDN_SUFFIXES = Object.freeze([
            '.szbdyd.com',
            '.mountaintoys.cn',
            '.nexusedgeio.com',
            '.ahdohpiechei.com'
        ]);

        function stableUnique(values) {
            const seen = new Set();
            const result = [];
            for (const value of values || []) {
                if (typeof value !== 'string' || !value || seen.has(value)) {
                    continue;
                }
                seen.add(value);
                result.push(value);
            }
            return result;
        }

        function defaultUiPosition(
            viewportWidth,
            viewportHeight,
            viewportLeft = 0,
            viewportTop = 0
        ) {
            const width = Math.max(0, Number(viewportWidth) || 0);
            const height = Math.max(0, Number(viewportHeight) || 0);
            const left = Number(viewportLeft) || 0;
            const top = Number(viewportTop) || 0;
            return {
                x:
                    left +
                    Math.max(
                        0,
                        width - UI_LAUNCHER_SIZE - 18
                    ),
                y:
                    top +
                    Math.max(
                        0,
                        height - UI_LAUNCHER_SIZE - 72
                    )
            };
        }

        function clampedUiAxis(value, viewportStart, viewportSize) {
            const available = viewportSize - UI_LAUNCHER_SIZE;
            if (available <= 0) {
                return viewportStart;
            }
            const margin = Math.min(
                UI_VIEWPORT_MARGIN,
                available / 2
            );
            const minimum = viewportStart + margin;
            const maximum =
                viewportStart + available - margin;
            return Math.round(
                Math.min(maximum, Math.max(minimum, value))
            );
        }

        function clampUiPosition(
            position,
            viewportWidth,
            viewportHeight,
            viewportLeft = 0,
            viewportTop = 0
        ) {
            const width = Math.max(0, Number(viewportWidth) || 0);
            const height = Math.max(0, Number(viewportHeight) || 0);
            const left = Number(viewportLeft) || 0;
            const top = Number(viewportTop) || 0;
            const fallback = defaultUiPosition(
                width,
                height,
                left,
                top
            );
            const x =
                typeof position?.x === 'number' &&
                Number.isFinite(position.x)
                    ? position.x
                    : fallback.x;
            const y =
                typeof position?.y === 'number' &&
                Number.isFinite(position.y)
                    ? position.y
                    : fallback.y;
            return {
                x: clampedUiAxis(x, left, width),
                y: clampedUiAxis(y, top, height)
            };
        }

        function pointerMovedBeyondThreshold(
            startX,
            startY,
            currentX,
            currentY
        ) {
            const deltaX = Number(currentX) - Number(startX);
            const deltaY = Number(currentY) - Number(startY);
            return (
                Number.isFinite(deltaX) &&
                Number.isFinite(deltaY) &&
                deltaX * deltaX + deltaY * deltaY >=
                    UI_DRAG_THRESHOLD_PX * UI_DRAG_THRESHOLD_PX
            );
        }

        function parseUrl(rawUrl) {
            if (typeof rawUrl !== 'string' || !rawUrl) {
                return null;
            }
            try {
                const url = new URL(
                    rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl
                );
                if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                    return null;
                }
                return url;
            } catch (_) {
                return null;
            }
        }

        function hostOf(rawUrl) {
            return parseUrl(rawUrl)?.hostname.toLowerCase() || '';
        }

        function isAkamaiHost(host) {
            return String(host || '').toLowerCase().endsWith('.akamaized.net');
        }

        function isOfficialCdnHost(host) {
            const normalized = String(host || '').toLowerCase();
            return (
                normalized.endsWith('.bilivideo.com') ||
                normalized.endsWith('.akamaized.net')
            );
        }

        function isMediaUrl(rawUrl) {
            const url = parseUrl(rawUrl);
            if (!url || url.pathname.includes('/live-bvc/')) {
                return false;
            }
            const pathAndQuery = `${url.pathname}${url.search}`;
            return (
                MEDIA_PATH_RE.test(pathAndQuery) ||
                url.pathname.startsWith('/upgcxcode/') ||
                url.pathname.startsWith('/v1/resource/')
            );
        }

        function isExplicitPcdn(rawUrl) {
            const url = parseUrl(rawUrl);
            if (!url) {
                return false;
            }

            const host = url.hostname.toLowerCase();
            const firstLabel = host.split('.')[0];
            const nonDefaultPort =
                !!url.port &&
                !(
                    (url.protocol === 'https:' && url.port === '443') ||
                    (url.protocol === 'http:' && url.port === '80')
                );

            return (
                IPV4_RE.test(host) ||
                host.includes('.mcdn.bilivideo.') ||
                /^xy(?:\d+x){3}\d+xy\.mcdn\.bilivideo\./i.test(host) ||
                PCDN_SUFFIXES.some(suffix => host.endsWith(suffix)) ||
                (firstLabel.startsWith('upos-') && firstLabel.includes('302')) ||
                host === 'upos-sz-mirror14b.bilivideo.com' ||
                nonDefaultPort ||
                /(?:^|[?&])os=mcdn(?:&|$)/i.test(url.search)
            );
        }

        function isObservableMediaRequest(rawUrl) {
            const host = hostOf(rawUrl);
            return !!(
                host &&
                isMediaUrl(rawUrl) &&
                (isOfficialCdnHost(host) || isExplicitPcdn(rawUrl))
            );
        }

        // Replace only the URL authority. Everything after it stays byte-for-
        // byte identical, including duplicate parameters, escaping and hdnts.
        function safeSwapHost(rawUrl, targetHost) {
            const host = String(targetHost || '')
                .trim()
                .replace(/^https?:\/\//i, '')
                .replace(/\/.*$/, '');

            if (
                !host ||
                isAkamaiHost(host) ||
                /[\s/?#]/.test(host)
            ) {
                return null;
            }

            // Conservative signature boundary: even though some current Akamai
            // URLs happen to work when moved back to UPOS, do not make that a
            // long-term assumption. Akamai-only entries remain untouched.
            if (isAkamaiHost(hostOf(rawUrl))) {
                return null;
            }

            const match = String(rawUrl || '').match(
                /^(https?:\/\/)([^/?#]+)([\s\S]*)$/i
            );
            if (!match) {
                return null;
            }
            return `${match[1]}${host}${match[3]}`;
        }

        function collectOriginals(entry) {
            if (!entry || typeof entry !== 'object') {
                return [];
            }

            const values = [
                entry.baseUrl,
                entry.base_url,
                entry.url
            ];

            for (const key of ['backupUrl', 'backup_url', 'backup_url_list']) {
                if (Array.isArray(entry[key])) {
                    values.push(...entry[key]);
                }
            }

            return stableUnique(values).filter(isMediaUrl);
        }

        function makeCandidate(url, original, originalIndex) {
            return {
                url,
                host: hostOf(url),
                original,
                synthetic: !original,
                originalIndex,
                pcdn: isExplicitPcdn(url)
            };
        }

        function buildCandidates(originals, safeHosts = SAFE_GENERIC_HOSTS) {
            const candidates = [];
            const seenUrls = new Set();

            function add(url, original, originalIndex) {
                if (
                    typeof url !== 'string' ||
                    !isMediaUrl(url) ||
                    seenUrls.has(url)
                ) {
                    return;
                }
                seenUrls.add(url);
                candidates.push(makeCandidate(url, original, originalIndex));
            }

            originals.forEach((url, index) => add(url, true, index));

            const donor = originals.find(url => {
                const host = hostOf(url);
                return (
                    host.endsWith('.bilivideo.com') &&
                    !isExplicitPcdn(url) &&
                    isMediaUrl(url)
                );
            });

            if (!donor) {
                return candidates;
            }

            for (let index = 0; index < safeHosts.length; index += 1) {
                const host = String(safeHosts[index] || '').toLowerCase();
                if (
                    !host ||
                    isAkamaiHost(host) ||
                    !host.endsWith('.bilivideo.com')
                ) {
                    continue;
                }

                // Prefer an exact API-provided URL for a host when present.
                if (originals.some(url => hostOf(url) === host)) {
                    continue;
                }

                const swapped = safeSwapHost(donor, host);
                if (swapped && !isExplicitPcdn(swapped)) {
                    add(swapped, false, originals.length + index);
                }
            }

            return candidates;
        }

        function healthTtlMs(record) {
            return record?.ok ? HEALTH_TTL_MS : FAILED_HEALTH_TTL_MS;
        }

        function healthExpiryAt(record) {
            return record && typeof record.sampledAt === 'number'
                ? record.sampledAt + healthTtlMs(record)
                : 0;
        }

        function isFreshHealth(record, now = Date.now()) {
            return !!(
                record &&
                typeof record.sampledAt === 'number' &&
                record.sampledAt <= now + 60 * 1000 &&
                now <= healthExpiryAt(record)
            );
        }

        function verifiedAtOf(record, now = Date.now()) {
            const verifiedAt = record?.verifiedAt;
            return typeof verifiedAt === 'number' &&
                Number.isFinite(verifiedAt) &&
                verifiedAt <= now + 60 * 1000
                ? verifiedAt
                : Number(record?.sampledAt) || 0;
        }

        function needsHealthVerification(record, now = Date.now()) {
            return !!(
                record?.ok &&
                isFreshHealth(record, now) &&
                now - verifiedAtOf(record, now) >=
                    HEALTH_VERIFY_INTERVAL_MS
            );
        }

        function verificationLimitMs(record) {
            const baseline = Number(record?.worstMs) || 0;
            return Math.min(
                PROBE_TIMEOUT_MS,
                Math.max(
                    VERIFY_SLOW_MIN_MS,
                    baseline * VERIFY_SLOW_FACTOR
                )
            );
        }

        function isVerificationAcceptable(sample, record) {
            return !!(
                sample?.ok &&
                Number.isFinite(sample.totalMs) &&
                sample.totalMs <= verificationLimitMs(record)
            );
        }

        function coldOrder(candidates, includeSynthetic = true) {
            return candidates
                .filter(candidate => includeSynthetic || candidate.original)
                .slice()
                .sort((a, b) => {
                    if (a.pcdn !== b.pcdn) {
                        return a.pcdn ? 1 : -1;
                    }
                    if (a.synthetic !== b.synthetic) {
                        return a.synthetic ? 1 : -1;
                    }
                    return a.originalIndex - b.originalIndex;
                });
        }

        function successRatio(record) {
            if (!record || !(record.attempts > 0)) {
                return 0;
            }
            return (record.successes || 0) / record.attempts;
        }

        function compareSuccessfulHealth(aRecord, bRecord, a, b) {
            const ratioDelta = successRatio(bRecord) - successRatio(aRecord);
            if (Math.abs(ratioDelta) > 0.001) {
                return ratioDelta;
            }

            const aWorst = Number.isFinite(aRecord.worstMs)
                ? aRecord.worstMs
                : PROBE_TIMEOUT_MS;
            const bWorst = Number.isFinite(bRecord.worstMs)
                ? bRecord.worstMs
                : PROBE_TIMEOUT_MS;
            const low = Math.max(1, Math.min(aWorst, bWorst));
            const high = Math.max(aWorst, bWorst);

            // Within 15%, keep the API/cache order to avoid pointless flapping.
            if (high / low <= 1.15) {
                return a.originalIndex - b.originalIndex;
            }
            return aWorst - bWorst;
        }

        function rankCandidates(candidates, health = {}, now = Date.now()) {
            const annotated = candidates.map(candidate => ({
                candidate,
                record: health[candidate.host],
                fresh: isFreshHealth(health[candidate.host], now)
            }));

            const hasFreshResult = annotated.some(item => item.fresh);
            const hasFreshSuccess = annotated.some(
                item => item.fresh && item.record?.ok
            );

            // If every result we have is bad, do not invent a new route: retain
            // Bilibili's exact original fallback chain.
            if (hasFreshResult && !hasFreshSuccess) {
                return coldOrder(candidates, false);
            }

            if (!hasFreshSuccess) {
                return coldOrder(candidates, true);
            }

            function group(item) {
                if (item.candidate.pcdn) {
                    return 5;
                }
                if (item.fresh && item.record?.ok) {
                    return 0;
                }
                if (!item.fresh && item.candidate.original) {
                    return 1;
                }
                if (!item.fresh && item.candidate.synthetic) {
                    return 2;
                }
                if (item.fresh && !item.record?.ok && item.candidate.original) {
                    return 3;
                }
                return 4;
            }

            return annotated
                .slice()
                .sort((a, b) => {
                    const groupDelta = group(a) - group(b);
                    if (groupDelta) {
                        return groupDelta;
                    }
                    if (group(a) === 0) {
                        const healthDelta = compareSuccessfulHealth(
                            a.record,
                            b.record,
                            a.candidate,
                            b.candidate
                        );
                        if (healthDelta) {
                            return healthDelta;
                        }
                    }
                    return (
                        a.candidate.originalIndex -
                        b.candidate.originalIndex
                    );
                })
                .map(item => item.candidate);
        }

        function isNativeSignedAkamai(candidate) {
            return !!(
                candidate?.original &&
                isAkamaiHost(candidate.host) &&
                /(?:^|[?&])hdnts=[^&]+/i.test(
                    parseUrl(candidate.url)?.search || ''
                )
            );
        }

        function rankManualCandidates(candidates, manualTarget) {
            const cold = coldOrder(candidates, true);
            let selected;

            if (manualTarget === NATIVE_AKAMAI_ROUTE) {
                selected = cold.filter(isNativeSignedAkamai);
            } else if (SAFE_GENERIC_HOSTS.includes(manualTarget)) {
                selected = cold.filter(
                    candidate =>
                        !candidate.pcdn &&
                        candidate.host === manualTarget
                );
            } else {
                return {
                    ordered: coldOrder(candidates, false),
                    matched: false
                };
            }

            if (!selected.length) {
                return {
                    ordered: coldOrder(candidates, false),
                    matched: false
                };
            }

            const selectedUrls = new Set(
                selected.map(candidate => candidate.url)
            );
            return {
                ordered: selected.concat(
                    cold.filter(
                        candidate => !selectedUrls.has(candidate.url)
                    )
                ),
                matched: true
            };
        }

        function sameStringArray(a, b) {
            return (
                a.length === b.length &&
                a.every((value, index) => value === b[index])
            );
        }

        function applyOrdering(entry, orderedCandidates) {
            const urls = stableUnique(
                orderedCandidates.map(candidate => candidate.url)
            );
            if (!entry || !urls.length) {
                return false;
            }

            const before = collectOriginals(entry);
            const base = urls[0];
            const backups = urls.slice(1);
            const isDurl =
                typeof entry.url === 'string' &&
                typeof entry.baseUrl !== 'string' &&
                typeof entry.base_url !== 'string';

            if (isDurl) {
                entry.url = base;
                entry.backupUrl = backups.slice();
                entry.backup_url = backups.slice();
            } else {
                entry.baseUrl = base;
                entry.base_url = base;
                entry.backupUrl = backups.slice();
                entry.backup_url = backups.slice();
            }

            return !sameStringArray(before, collectOriginals(entry));
        }

        function walkMediaEntries(value, callback, depth = 0, seen = new WeakSet()) {
            if (
                value == null ||
                typeof value !== 'object' ||
                depth > 20 ||
                seen.has(value)
            ) {
                return;
            }
            seen.add(value);

            const originals = collectOriginals(value);
            if (originals.length) {
                callback(value, originals);
                return;
            }

            if (Array.isArray(value)) {
                for (const item of value) {
                    walkMediaEntries(item, callback, depth + 1, seen);
                }
                return;
            }

            for (const key of Object.keys(value)) {
                walkMediaEntries(value[key], callback, depth + 1, seen);
            }
        }

        function planFromCandidates(
            candidates,
            safeHosts = SAFE_GENERIC_HOSTS,
            preferredHost = ''
        ) {
            const byHost = new Map();
            for (const candidate of candidates) {
                if (
                    !candidate.host ||
                    candidate.pcdn ||
                    !isOfficialCdnHost(candidate.host) ||
                    (isAkamaiHost(candidate.host) && !candidate.original)
                ) {
                    continue;
                }

                // An Akamai entry reaches this point only when it was present
                // verbatim in the API response. safeSwapHost never creates one.
                const route = {
                    host: candidate.host,
                    url: candidate.url,
                    original: !!candidate.original,
                    originalIndex: candidate.originalIndex,
                    nativeAkamai:
                        isAkamaiHost(candidate.host) && candidate.original
                };
                const existing = byHost.get(candidate.host);
                if (
                    !existing ||
                    (!existing.original && route.original) ||
                    (existing.original &&
                        route.original &&
                        route.originalIndex < existing.originalIndex)
                ) {
                    byHost.set(candidate.host, route);
                }
            }

            const originals = [...byHost.values()]
                .filter(route => route.original)
                .sort((a, b) => a.originalIndex - b.originalIndex);
            const selected = [];
            const selectedHosts = new Set();

            function add(route) {
                if (
                    route &&
                    !selectedHosts.has(route.host) &&
                    selected.length < MAX_PROBE_HOSTS
                ) {
                    selectedHosts.add(route.host);
                    selected.push(route);
                    return true;
                }
                return false;
            }

            // Reserve two API-native slots. Prefer one ordinary UPOS donor and
            // one native Akamai route when both exist. The actual preferred
            // route is a hard reservation even if it was the third API backup.
            const preferred = byHost.get(preferredHost);
            add(preferred);
            const ordinaryOriginal = originals.find(
                route => !route.nativeAkamai
            );
            const nativeAkamai = originals.find(
                route => route.nativeAkamai
            );
            if (preferred?.original) {
                add(
                    preferred.nativeAkamai
                        ? ordinaryOriginal
                        : nativeAkamai
                );
            } else {
                add(ordinaryOriginal);
                add(nativeAkamai);
            }
            for (const route of originals) {
                if (
                    selected.filter(item => item.original).length >=
                    MAX_ORIGINAL_PROBE_HOSTS
                ) {
                    break;
                }
                add(route);
            }

            const presetHosts = stableUnique(
                (safeHosts || []).map(host =>
                    String(host || '').toLowerCase()
                )
            ).slice(0, MAX_PRESET_PROBE_HOSTS);
            for (const host of presetHosts) {
                add(byHost.get(host));
            }

            return selected.slice(0, MAX_PROBE_HOSTS);
        }

        function transformPlayInfo(
            payload,
            health = {},
            now = Date.now(),
            options = {}
        ) {
            const result = {
                payload,
                changed: false,
                entryCount: 0,
                probePlan: [],
                availableHosts: [],
                nativeAkamaiAvailable: false,
                winnerHost: '',
                usedFreshHealth: false,
                manualMatched: 0,
                manualMissed: 0
            };

            if (
                !payload ||
                typeof payload !== 'object' ||
                (payload.code !== undefined && payload.code !== 0)
            ) {
                return result;
            }

            const safeHosts = options.safeHosts || SAFE_GENERIC_HOSTS;
            const mode = options.mode === 'manual' ? 'manual' : 'auto';
            const manualTarget =
                options.manualTarget || DEFAULT_SETTINGS.manualTarget;

            walkMediaEntries(payload, (entry, originals) => {
                const candidates = buildCandidates(originals, safeHosts);
                if (!candidates.length) {
                    return;
                }

                result.availableHosts = stableUnique([
                    ...result.availableHosts,
                    ...candidates.map(candidate => candidate.host)
                ]);
                result.nativeAkamaiAvailable =
                    result.nativeAkamaiAvailable ||
                    candidates.some(isNativeSignedAkamai);

                let ordered;
                let manualMatched = false;
                if (mode === 'manual') {
                    const manual = rankManualCandidates(
                        candidates,
                        manualTarget
                    );
                    ordered = manual.ordered;
                    manualMatched = manual.matched;
                    if (manualMatched) {
                        result.manualMatched += 1;
                    } else {
                        result.manualMissed += 1;
                    }
                } else {
                    ordered = rankCandidates(candidates, health, now);
                }
                if (!ordered.length) {
                    return;
                }

                if (!result.winnerHost) {
                    result.winnerHost =
                        mode === 'manual' && !manualMatched
                            ? ''
                            : ordered[0].host;
                    result.usedFreshHealth = !!(
                        mode === 'auto' &&
                        isFreshHealth(health[ordered[0].host], now) &&
                        health[ordered[0].host]?.ok
                    );
                }
                if (!result.probePlan.length) {
                    result.probePlan = planFromCandidates(
                        candidates,
                        safeHosts,
                        result.winnerHost
                    );
                }

                if (mode !== 'manual' || manualMatched) {
                    result.changed =
                        applyOrdering(entry, ordered) || result.changed;
                }
                result.entryCount += 1;
            });

            return result;
        }

        function median(values) {
            const sorted = values
                .filter(Number.isFinite)
                .slice()
                .sort((a, b) => a - b);
            if (!sorted.length) {
                return 0;
            }
            const middle = Math.floor(sorted.length / 2);
            return sorted.length % 2
                ? sorted[middle]
                : (sorted[middle - 1] + sorted[middle]) / 2;
        }

        function aggregateProbeSamples(host, samples, sampledAt = Date.now()) {
            const successful = samples.filter(sample => sample.ok);
            return {
                host,
                // Stability wins over a flashy peak: a host is promoted only
                // when both the beginning and a later range complete.
                ok:
                    samples.length > 0 &&
                    successful.length === samples.length,
                attempts: samples.length,
                successes: successful.length,
                medianMbps: median(successful.map(sample => sample.mbps)),
                medianTtfbMs: median(
                    successful.map(sample => sample.ttfbMs)
                ),
                worstMs: Math.max(
                    ...samples.map(sample =>
                        sample.ok ? sample.totalMs : PROBE_TIMEOUT_MS
                    ),
                    PROBE_TIMEOUT_MS * (samples.length ? 0 : 1)
                ),
                sampledAt,
                verifiedAt: sampledAt
            };
        }

        function compareHealthRecords(a, b) {
            const ratioDelta = successRatio(b) - successRatio(a);
            if (Math.abs(ratioDelta) > 0.001) {
                return ratioDelta;
            }
            const worstDelta =
                (a.worstMs || PROBE_TIMEOUT_MS) -
                (b.worstMs || PROBE_TIMEOUT_MS);
            if (worstDelta) {
                return worstDelta;
            }
            return (
                (a.medianTtfbMs || PROBE_TIMEOUT_MS) -
                (b.medianTtfbMs || PROBE_TIMEOUT_MS)
            );
        }

        function uniqueProbeRoutes(plan) {
            const routes = [];
            const seenHosts = new Set();
            for (const route of plan || []) {
                if (
                    !route?.host ||
                    !route.url ||
                    seenHosts.has(route.host)
                ) {
                    continue;
                }
                seenHosts.add(route.host);
                routes.push(route);
            }
            return routes;
        }

        function planProbeWork(
            plan,
            health = {},
            now = Date.now(),
            preferredHost = '',
            force = false
        ) {
            const routes = uniqueProbeRoutes(plan);
            if (!routes.length) {
                return {
                    kind: 'none',
                    verifyRoute: null,
                    routes: []
                };
            }
            if (force) {
                return {
                    kind: 'full',
                    verifyRoute: null,
                    routes
                };
            }

            const healthy = routes
                .map(route => ({
                    route,
                    record: health[route.host]
                }))
                .filter(
                    item =>
                        item.record?.ok &&
                        isFreshHealth(item.record, now)
                )
                .sort((a, b) =>
                    compareHealthRecords(a.record, b.record)
                );
            const preferred = healthy.find(
                item => item.route.host === preferredHost
            );
            const verifyItem = preferredHost
                ? preferred || null
                : healthy[0] || null;
            const verifyRoute =
                verifyItem &&
                needsHealthVerification(verifyItem.record, now)
                    ? verifyItem.route
                    : null;
            const staleRoutes = routes.filter(route => {
                const record = health[route.host];
                return !record || !isFreshHealth(record, now);
            });

            if (!healthy.length) {
                if (!staleRoutes.length) {
                    // Every route is inside the short failed-result cooldown.
                    return {
                        kind: 'none',
                        verifyRoute: null,
                        routes: []
                    };
                }
                return {
                    kind:
                        staleRoutes.length === routes.length
                            ? 'full'
                            : 'adaptive',
                    verifyRoute: null,
                    routes: staleRoutes
                };
            }

            if (!verifyRoute && !staleRoutes.length) {
                return {
                    kind: 'none',
                    verifyRoute: null,
                    routes: []
                };
            }
            return {
                kind: 'adaptive',
                verifyRoute,
                routes: staleRoutes
            };
        }

        function formatProbeAge(sampledAt, now = Date.now()) {
            if (!sampledAt) {
                return '';
            }
            const seconds = Math.max(
                0,
                Math.floor((now - sampledAt) / 1000)
            );
            if (seconds < 60) {
                return '刚刚';
            }
            if (seconds < 3600) {
                return `${Math.floor(seconds / 60)} 分钟前`;
            }
            if (seconds < 86400) {
                return `${Math.floor(seconds / 3600)} 小时前`;
            }
            return `${Math.floor(seconds / 86400)} 天前`;
        }

        function install(root) {
            if (
                !root ||
                root.__BILI_AUTO_CDN_STABLE_INSTALLED__ ||
                typeof root.fetch !== 'function' ||
                typeof root.XMLHttpRequest !== 'function'
            ) {
                return;
            }

            const nativeFetch = root.fetch;
            const NativeXHR = root.XMLHttpRequest;
            const NativeResponse = root.Response;
            const NativeHeaders = root.Headers;
            const nativeJsonParse = root.JSON.parse.bind(root.JSON);
            const nativeJsonStringify = root.JSON.stringify.bind(root.JSON);
            const logPrefix = '[BiliAutoCDN]';
            const ROUTE_DEFS = Object.freeze([
                {
                    id: 'auto',
                    label: '自动选择',
                    short: '自动',
                    description: ''
                },
                {
                    id: 'original',
                    label: 'B站原始',
                    short: '原始',
                    description: '完全不修改播放地址'
                },
                {
                    id: SAFE_GENERIC_HOSTS[0],
                    label: 'Cosov',
                    short: 'COSOV',
                    description: '国际 UPOS'
                },
                {
                    id: NATIVE_AKAMAI_ROUTE,
                    label: '原生 Akamai',
                    short: 'AKAMAI',
                    description: '仅使用 API 原生签名'
                },
                {
                    id: SAFE_GENERIC_HOSTS[1],
                    label: 'Aliov',
                    short: 'ALIOV',
                    description: '阿里 UPOS'
                },
                {
                    id: SAFE_GENERIC_HOSTS[2],
                    label: '香港 EQ',
                    short: 'HK EQ',
                    description: '香港 UPOS'
                }
            ]);

            const settings = loadSettings();
            const state = {
                enabled: settings.enabled,
                mode: settings.mode,
                manualTarget: settings.manualTarget,
                autoProbe: settings.autoProbe,
                health: loadHealth(),
                probePromise: null,
                probeGeneration: 0,
                activeProbeGeneration: 0,
                activeProbeKey: '',
                activeProbeForced: false,
                pendingProbe: null,
                phase: settings.enabled ? 'idle' : 'off',
                lastWinner: '',
                lastSource: '',
                lastProbeAt: 0,
                benchmarkWinner: '',
                observedHost: '',
                currentPlan: [],
                availableHosts: [],
                nativeAkamaiAvailable: false,
                manualMatched: 0,
                manualMissed: 0,
                probeProgress: null,
                probeResourceCounts: new Map(),
                phaseNote: ''
            };
            const ui = {
                mounted: false,
                open: false,
                pendingRoute: '',
                host: null,
                shadow: null,
                refs: {},
                routeRefs: new Map(),
                position: null,
                preferredPosition: null,
                drag: null,
                ageTimer: null,
                suppressLauncherClickUntil: 0
            };
            root.__BILI_AUTO_CDN_STABLE_INSTALLED__ = true;

            function loadSettings() {
                try {
                    const stored = nativeJsonParse(
                        root.localStorage.getItem(SETTINGS_KEY) || 'null'
                    );
                    const legacyEnabled =
                        root.localStorage.getItem(ENABLED_KEY) !== '0';
                    return normalizeSettings(stored, legacyEnabled);
                } catch (_) {
                    return { ...DEFAULT_SETTINGS };
                }
            }

            function saveSettings(nextSettings) {
                const normalized = normalizeSettings(
                    nextSettings,
                    state.enabled
                );
                const enabledChanged =
                    state.enabled !== normalized.enabled;
                try {
                    root.localStorage.setItem(
                        SETTINGS_KEY,
                        nativeJsonStringify(normalized)
                    );
                } catch (_) {
                    return false;
                }
                // Keep the v0.1 switch in sync for users who still call the old
                // Console API. Failure here does not invalidate the canonical
                // versioned settings object that was already saved.
                try {
                    root.localStorage.setItem(
                        ENABLED_KEY,
                        normalized.enabled ? '1' : '0'
                    );
                } catch (_) {}

                state.enabled = normalized.enabled;
                state.mode = normalized.mode;
                state.manualTarget = normalized.manualTarget;
                state.autoProbe = normalized.autoProbe;
                if (enabledChanged) {
                    state.phase = normalized.enabled ? 'idle' : 'off';
                }
                renderUi();
                return true;
            }

            function viewportSize() {
                const documentElement =
                    root.document?.documentElement;
                const visual = root.visualViewport;
                return {
                    width:
                        Number(visual?.width) ||
                        Number(root.innerWidth) ||
                        Number(documentElement?.clientWidth) ||
                        1024,
                    height:
                        Number(visual?.height) ||
                        Number(root.innerHeight) ||
                        Number(documentElement?.clientHeight) ||
                        768,
                    left: Number(visual?.offsetLeft) || 0,
                    top: Number(visual?.offsetTop) || 0
                };
            }

            function loadUiPosition() {
                const viewport = viewportSize();
                try {
                    return clampUiPosition(
                        nativeJsonParse(
                            root.localStorage.getItem(
                                UI_POSITION_KEY
                            ) || 'null'
                        ),
                        viewport.width,
                        viewport.height,
                        viewport.left,
                        viewport.top
                    );
                } catch (_) {
                    return defaultUiPosition(
                        viewport.width,
                        viewport.height,
                        viewport.left,
                        viewport.top
                    );
                }
            }

            function saveUiPosition(position) {
                try {
                    root.localStorage.setItem(
                        UI_POSITION_KEY,
                        nativeJsonStringify(position)
                    );
                } catch (_) {
                    // Position persistence is optional in private contexts.
                }
            }

            function applyUiPosition(position, persist = false) {
                const viewport = viewportSize();
                const next = clampUiPosition(
                    position,
                    viewport.width,
                    viewport.height,
                    viewport.left,
                    viewport.top
                );
                ui.position = next;
                if (ui.host) {
                    ui.host.style.left = `${next.x}px`;
                    ui.host.style.top = `${next.y}px`;
                    ui.host.style.right = 'auto';
                    ui.host.style.bottom = 'auto';
                }
                if (persist) {
                    ui.preferredPosition = next;
                    saveUiPosition(next);
                }
                if (ui.open) {
                    positionPanel();
                }
                return next;
            }

            function positionPanel() {
                if (
                    !ui.mounted ||
                    !ui.open ||
                    ui.refs.panel?.hidden
                ) {
                    return;
                }
                const viewport = viewportSize();
                const launcherRect =
                    ui.refs.launcher.getBoundingClientRect();
                const hostRect = ui.host.getBoundingClientRect();
                const panel = ui.refs.panel;
                const margin = 12;
                const gap = 6;

                panel.style.left = '0px';
                panel.style.top = `${
                    launcherRect.height + gap
                }px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.width = `${Math.max(
                    1,
                    Math.min(370, viewport.width - margin * 2)
                )}px`;
                panel.style.maxHeight = `${Math.min(
                    650,
                    Math.max(48, viewport.height - margin * 2)
                )}px`;

                const initialRect = panel.getBoundingClientRect();
                const panelWidth = initialRect.width;
                const spaceAbove = Math.max(
                    0,
                    launcherRect.top -
                        gap -
                        viewport.top -
                        margin
                );
                const spaceBelow = Math.max(
                    0,
                    viewport.top +
                        viewport.height -
                        launcherRect.bottom -
                        gap -
                        margin
                );
                const placeAbove = spaceAbove > spaceBelow;
                const availableHeight = placeAbove
                    ? spaceAbove
                    : spaceBelow;
                panel.style.maxHeight = `${Math.min(
                    650,
                    Math.max(48, availableHeight)
                )}px`;

                const measuredRect = panel.getBoundingClientRect();
                const panelHeight =
                    measuredRect.height ||
                    Math.min(650, Math.max(48, availableHeight));
                const preferredLeft =
                    launcherRect.left + launcherRect.width / 2 <=
                    viewport.left + viewport.width / 2
                        ? launcherRect.left
                        : launcherRect.right - panelWidth;
                const minLeft = viewport.left + margin;
                const maxLeft = Math.max(
                    minLeft,
                    viewport.left +
                        viewport.width -
                        panelWidth -
                        margin
                );
                const left = Math.min(
                    maxLeft,
                    Math.max(minLeft, preferredLeft)
                );
                const preferredTop = placeAbove
                    ? launcherRect.top - gap - panelHeight
                    : launcherRect.bottom + gap;
                const minTop = viewport.top + margin;
                const maxTop = Math.max(
                    minTop,
                    viewport.top +
                        viewport.height -
                        panelHeight -
                        margin
                );
                const top = Math.min(
                    maxTop,
                    Math.max(minTop, preferredTop)
                );

                panel.style.left = `${Math.round(
                    left - hostRect.left
                )}px`;
                panel.style.top = `${Math.round(
                    top - hostRect.top
                )}px`;
                panel.style.transformOrigin = `${
                    launcherRect.left + launcherRect.width / 2 <=
                    left + panelWidth / 2
                        ? 'left'
                        : 'right'
                } ${placeAbove ? 'bottom' : 'top'}`;
            }

            function beginLauncherDrag(event) {
                if (
                    event.isPrimary === false ||
                    (typeof event.button === 'number' &&
                        event.button !== 0)
                ) {
                    return;
                }
                const rect = ui.host.getBoundingClientRect();
                ui.drag = {
                    pointerId: event.pointerId,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    startLeft: rect.left,
                    startTop: rect.top,
                    moved: false
                };
                ui.refs.launcher.classList.add(
                    'launcher--dragging'
                );
                try {
                    ui.refs.launcher.setPointerCapture(
                        event.pointerId
                    );
                } catch (_) {}
            }

            function moveLauncherDrag(event) {
                const drag = ui.drag;
                if (!drag || event.pointerId !== drag.pointerId) {
                    return;
                }
                if (
                    !drag.moved &&
                    pointerMovedBeyondThreshold(
                        drag.startClientX,
                        drag.startClientY,
                        event.clientX,
                        event.clientY
                    )
                ) {
                    drag.moved = true;
                }
                if (!drag.moved) {
                    return;
                }
                event.preventDefault();
                applyUiPosition({
                    x:
                        drag.startLeft +
                        event.clientX -
                        drag.startClientX,
                    y:
                        drag.startTop +
                        event.clientY -
                        drag.startClientY
                });
            }

            function endLauncherDrag(event, cancelled = false) {
                const drag = ui.drag;
                if (!drag || event.pointerId !== drag.pointerId) {
                    return;
                }
                if (
                    !cancelled &&
                    !drag.moved &&
                    pointerMovedBeyondThreshold(
                        drag.startClientX,
                        drag.startClientY,
                        event.clientX,
                        event.clientY
                    )
                ) {
                    drag.moved = true;
                }
                if (drag.moved && !cancelled) {
                    applyUiPosition({
                        x:
                            drag.startLeft +
                            event.clientX -
                            drag.startClientX,
                        y:
                            drag.startTop +
                            event.clientY -
                            drag.startClientY
                    });
                } else if (drag.moved) {
                    applyUiPosition({
                        x: drag.startLeft,
                        y: drag.startTop
                    });
                }
                ui.drag = null;
                ui.refs.launcher.classList.remove(
                    'launcher--dragging'
                );
                try {
                    ui.refs.launcher.releasePointerCapture(
                        event.pointerId
                    );
                } catch (_) {}
                if (!drag.moved) {
                    return;
                }
                if (!cancelled) {
                    event.preventDefault();
                    applyUiPosition(ui.position, true);
                    ui.suppressLauncherClickUntil =
                        Date.now() + 500;
                }
            }

            function handleLauncherClick(event) {
                if (
                    event.detail !== 0 &&
                    Date.now() <
                    ui.suppressLauncherClickUntil
                ) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                setUiOpen(!ui.open);
            }

            function log(...args) {
                root.console.info(logPrefix, ...args);
            }

            function loadHealth() {
                try {
                    const parsed = nativeJsonParse(
                        root.localStorage.getItem(CACHE_KEY) || 'null'
                    );
                    if (
                        !parsed ||
                        parsed.version !== CACHE_VERSION ||
                        !parsed.health ||
                        typeof parsed.health !== 'object'
                    ) {
                        return {};
                    }

                    const clean = {};
                    for (const [host, record] of Object.entries(parsed.health)) {
                        if (
                            typeof host === 'string' &&
                            record &&
                            typeof record.sampledAt === 'number'
                        ) {
                            clean[host] = {
                                host,
                                ok: !!record.ok,
                                attempts: Number(record.attempts) || 0,
                                successes: Number(record.successes) || 0,
                                medianMbps:
                                    Number(record.medianMbps) || 0,
                                medianTtfbMs:
                                    Number(record.medianTtfbMs) || 0,
                                worstMs:
                                    Number(record.worstMs) ||
                                    PROBE_TIMEOUT_MS,
                                sampledAt: record.sampledAt,
                                verifiedAt:
                                    typeof record.verifiedAt ===
                                        'number' &&
                                    Number.isFinite(record.verifiedAt)
                                        ? record.verifiedAt
                                        : record.sampledAt
                            };
                        }
                    }
                    return clean;
                } catch (_) {
                    return {};
                }
            }

            function saveHealth() {
                const sanitized = {};
                for (const [host, record] of Object.entries(state.health)) {
                    sanitized[host] = {
                        host,
                        ok: !!record.ok,
                        attempts: record.attempts,
                        successes: record.successes,
                        medianMbps: Number(
                            (record.medianMbps || 0).toFixed(3)
                        ),
                        medianTtfbMs: Number(
                            (record.medianTtfbMs || 0).toFixed(1)
                        ),
                        worstMs: Number((record.worstMs || 0).toFixed(1)),
                        sampledAt: record.sampledAt,
                        verifiedAt: verifiedAtOf(record)
                    };
                }
                try {
                    root.localStorage.setItem(
                        CACHE_KEY,
                        nativeJsonStringify({
                            version: CACHE_VERSION,
                            health: sanitized
                        })
                    );
                } catch (_) {
                    // A private/incognito context may reject localStorage.
                }
            }

            function requestUrlOf(input) {
                if (typeof input === 'string') {
                    return input;
                }
                if (input && typeof input.href === 'string') {
                    return input.href;
                }
                if (input && typeof input.url === 'string') {
                    return input.url;
                }
                return '';
            }

            function isPlayUrlApi(rawUrl) {
                try {
                    const url = new URL(rawUrl, root.location.href);
                    return (
                        url.hostname === 'api.bilibili.com' &&
                        PLAYURL_PATHS.has(url.pathname)
                    );
                } catch (_) {
                    return false;
                }
            }

            function bestHealthyHost(hosts = []) {
                const allowed = new Set(hosts.filter(Boolean));
                const records = Object.values(state.health)
                    .filter(
                        record =>
                            record.ok &&
                            isFreshHealth(record) &&
                            (!allowed.size || allowed.has(record.host))
                    )
                    .sort(compareHealthRecords);
                return records[0]?.host || '';
            }

            function routeDefinition(id) {
                return ROUTE_DEFS.find(route => route.id === id);
            }

            function routeForHost(host) {
                if (!host) {
                    return null;
                }
                const exact = ROUTE_DEFS.find(route => route.id === host);
                if (exact) {
                    return exact;
                }
                if (isAkamaiHost(host)) {
                    return routeDefinition(NATIVE_AKAMAI_ROUTE);
                }
                return null;
            }

            function displayHost(host, emptyText = '尚未观测') {
                if (!host) {
                    return emptyText;
                }
                return routeForHost(host)?.label || host;
            }

            function currentRouteId() {
                if (!state.enabled) {
                    return 'original';
                }
                return state.mode === 'manual'
                    ? state.manualTarget
                    : 'auto';
            }

            function availabilityForRoute(route) {
                if (route.id === 'auto' || route.id === 'original') {
                    return { available: true, reason: '' };
                }
                if (
                    !state.enabled &&
                    SAFE_GENERIC_HOSTS.includes(route.id)
                ) {
                    return { available: true, reason: '' };
                }
                if (route.id === NATIVE_AKAMAI_ROUTE) {
                    return state.nativeAkamaiAvailable
                        ? { available: true, reason: '' }
                        : {
                              available: false,
                              reason: state.currentPlan.length
                                  ? '本视频没有原生签名 Akamai'
                                  : '打开视频后检测可用性'
                          };
                }
                return state.availableHosts.includes(route.id)
                    ? { available: true, reason: '' }
                    : {
                          available: false,
                          reason: state.currentPlan.length
                              ? '本视频无法安全生成该线路'
                              : '打开视频后检测可用性'
                      };
            }

            function healthForRoute(route) {
                if (route.id === NATIVE_AKAMAI_ROUTE) {
                    const native = state.currentPlan.find(
                        item => item.nativeAkamai
                    );
                    return native ? state.health[native.host] : null;
                }
                return state.health[route.id] || null;
            }

            function setUiOpen(next, restoreFocus = false) {
                ui.open = !!next;
                if (!ui.mounted) {
                    return;
                }
                ui.refs.panel.hidden = !ui.open;
                ui.refs.launcher.setAttribute(
                    'aria-expanded',
                    ui.open ? 'true' : 'false'
                );
                ui.refs.launcher.setAttribute(
                    'aria-label',
                    ui.open
                        ? '收起视频线路控制面板'
                        : '打开视频线路控制面板'
                );
                ui.refs.launcher.title = ui.open
                    ? '拖动移动；点击收起线路面板'
                    : '拖动移动；点击打开线路面板';
                if (ui.open) {
                    renderUi();
                    positionPanel();
                }
                if (!ui.open && restoreFocus) {
                    ui.refs.launcher.focus();
                }
            }

            function announce(message) {
                if (ui.mounted) {
                    ui.refs.live.textContent = '';
                    root.setTimeout(() => {
                        if (ui.mounted) {
                            ui.refs.live.textContent = message;
                        }
                    }, 10);
                }
            }

            function addBadge(container, text, kind = '') {
                const badge = root.document.createElement('span');
                badge.className = `badge${kind ? ` badge--${kind}` : ''}`;
                badge.textContent = text;
                container.appendChild(badge);
            }

            function buildRouteRows() {
                for (const route of ROUTE_DEFS) {
                    const label = root.document.createElement('label');
                    label.className = 'route';
                    label.dataset.route = route.id;

                    const radio = root.document.createElement('input');
                    radio.type = 'radio';
                    radio.name = 'kota-cdn-route';
                    radio.value = route.id;

                    const marker = root.document.createElement('span');
                    marker.className = 'route__marker';
                    marker.setAttribute('aria-hidden', 'true');

                    const body = root.document.createElement('span');
                    body.className = 'route__body';
                    const top = root.document.createElement('span');
                    top.className = 'route__top';
                    const name = root.document.createElement('strong');
                    name.className = 'route__name';
                    name.textContent = route.label;
                    const metrics = root.document.createElement('span');
                    metrics.className = 'route__metrics';
                    top.append(name, metrics);

                    const bottom = root.document.createElement('span');
                    bottom.className = 'route__bottom';
                    const meta = root.document.createElement('span');
                    meta.className = 'route__meta';
                    const badges = root.document.createElement('span');
                    badges.className = 'route__badges';
                    bottom.append(meta, badges);
                    body.append(top, bottom);
                    label.append(radio, marker, body);
                    ui.refs.routeList.appendChild(label);

                    radio.addEventListener('change', () => {
                        if (!radio.checked) {
                            return;
                        }
                        ui.pendingRoute = route.id;
                        renderUi();
                    });

                    ui.routeRefs.set(route.id, {
                        label,
                        radio,
                        metrics,
                        meta,
                        badges
                    });
                }
            }

            function pendingDescription(routeId) {
                const route = routeDefinition(routeId);
                if (!route) {
                    return '';
                }
                if (routeId === 'original') {
                    return '将停用脚本，B站播放地址保持原样。';
                }
                if (routeId === 'auto') {
                    return '将改为自动选择；刷新后生效。';
                }
                return `将优先使用 ${route.label}；其他原生线路仍作为回退。`;
            }

            function saveRouteAndReload(routeId) {
                const next = {
                    version: DEFAULT_SETTINGS.version,
                    enabled: routeId !== 'original',
                    mode:
                        routeId === 'auto' || routeId === 'original'
                            ? 'auto'
                            : 'manual',
                    manualTarget:
                        routeId === 'auto' || routeId === 'original'
                            ? state.manualTarget
                            : routeId,
                    autoProbe: state.autoProbe
                };
                if (!saveSettings(next)) {
                    showSettingsError(
                        '设置保存失败；本页没有切换线路'
                    );
                    return false;
                }
                ui.pendingRoute = '';
                renderUi();
                root.setTimeout(() => root.location.reload(), 80);
                return true;
            }

            function showSettingsError(message) {
                state.phase = 'error';
                state.phaseNote = message;
                renderUi();
                announce(message);
            }

            function clearCurrentHealthAndRetest() {
                if (
                    state.probePromise ||
                    !state.enabled ||
                    !state.currentPlan.length
                ) {
                    return;
                }
                for (const route of state.currentPlan) {
                    delete state.health[route.host];
                }
                state.benchmarkWinner = '';
                state.phaseNote = '';
                saveHealth();
                scheduleProbe(
                    state.currentPlan,
                    true,
                    state.lastWinner
                );
            }

            function stopAutomaticProbe() {
                const forcedProbeIsCurrent =
                    state.activeProbeForced &&
                    isCurrentProbe(state.activeProbeGeneration);
                if (
                    state.probePromise &&
                    !forcedProbeIsCurrent
                ) {
                    state.probeGeneration += 1;
                }
                if (
                    state.pendingProbe &&
                    !state.pendingProbe.force
                ) {
                    state.pendingProbe = null;
                }
                if (!state.probePromise || !forcedProbeIsCurrent) {
                    state.probeProgress = null;
                    state.phase = !state.enabled
                        ? 'off'
                        : state.benchmarkWinner
                          ? 'ready'
                          : 'idle';
                    state.phaseNote = state.enabled
                        ? '自动测速已关闭'
                        : '';
                }
                renderUi();
            }

            function setAutoProbeEnabled(next) {
                const wanted = !!next;
                if (
                    !saveSettings({
                        enabled: state.enabled,
                        mode: state.mode,
                        manualTarget: state.manualTarget,
                        autoProbe: wanted
                    })
                ) {
                    showSettingsError(
                        '设置保存失败；自动测速状态没有改变'
                    );
                    return false;
                }

                if (!wanted) {
                    stopAutomaticProbe();
                    announce('自动测速已关闭');
                    return true;
                }

                state.phaseNote = '';
                if (!state.probePromise) {
                    state.phase = state.benchmarkWinner
                        ? 'ready'
                        : 'idle';
                }
                scheduleProbe(
                    state.currentPlan,
                    false,
                    state.lastWinner
                );
                renderUi();
                announce('自动测速已开启');
                return true;
            }

            function phaseText() {
                if (state.phase === 'error') {
                    return state.phaseNote || '设置保存失败';
                }
                if (!state.enabled) {
                    return '脚本停用；播放地址保持原样';
                }
                if (state.phase === 'waiting') {
                    return '等待暂停播放，或至少 15 秒缓冲';
                }
                if (state.phase === 'probing') {
                    const progress = state.probeProgress;
                    if (progress) {
                        return `正在测试 ${displayHost(
                            progress.host,
                            progress.host
                        )} · ${
                            progress.verification
                                ? '轻量复核'
                                : `第 ${progress.rangeIndex}/${
                                      progress.rangeTotal || 2
                                  } 段`
                        }`;
                    }
                    return '正在串行测试线路';
                }
                if (state.phase === 'ready') {
                    return state.benchmarkWinner
                        ? `测速完成 · ${displayHost(
                              state.benchmarkWinner,
                              state.benchmarkWinner
                          )} 最稳`
                        : '测速缓存可用';
                }
                if (state.phase === 'failed') {
                    return '线路测速失败；继续使用 B站原始回退';
                }
                return (
                    state.phaseNote ||
                    (state.currentPlan.length
                        ? '可以重新测速'
                        : '等待视频播放地址')
                );
            }

            function renderUi() {
                if (!ui.mounted) {
                    return;
                }

                const selected = ui.pendingRoute || currentRouteId();
                ui.refs.launcher.dataset.phase =
                    state.phase === 'error'
                        ? 'error'
                        : state.enabled
                          ? state.phase
                          : 'off';

                for (const route of ROUTE_DEFS) {
                    const refs = ui.routeRefs.get(route.id);
                    const availability = availabilityForRoute(route);
                    const record = healthForRoute(route);
                    refs.radio.disabled = !availability.available;
                    refs.radio.checked = selected === route.id;
                    refs.label.classList.toggle(
                        'route--disabled',
                        !availability.available
                    );

                    if (route.id === 'auto' || route.id === 'original') {
                        refs.metrics.textContent = route.description;
                    } else if (record) {
                        const age = formatProbeAge(record.sampledAt);
                        const ageSuffix = age ? ` · ${age}` : '';
                        refs.metrics.textContent = record.ok
                            ? `${record.medianMbps.toFixed(
                                  1
                              )} Mbps · TTFB ${record.medianTtfbMs.toFixed(
                                  0
                              )} ms${ageSuffix}`
                            : `${record.successes}/${record.attempts} · 测试失败${ageSuffix}`;
                    } else {
                        refs.metrics.textContent = '未测试';
                    }

                    if (!availability.available) {
                        refs.meta.textContent = availability.reason;
                    } else if (
                        route.id === 'auto' ||
                        route.id === 'original'
                    ) {
                        refs.meta.textContent = '';
                    } else {
                        refs.meta.textContent =
                            route.id === NATIVE_AKAMAI_ROUTE
                                ? state.currentPlan.find(
                                      item => item.nativeAkamai
                                  )?.host || route.description
                                : route.id;
                    }
                    refs.meta.title = refs.meta.textContent;

                    refs.badges.replaceChildren();
                    if (route.id === currentRouteId()) {
                        addBadge(refs.badges, '当前', 'current');
                    }
                }

                ui.refs.pending.hidden = !ui.pendingRoute;
                ui.refs.pendingText.textContent = ui.pendingRoute
                    ? pendingDescription(ui.pendingRoute)
                    : '';
                ui.refs.apply.disabled = !ui.pendingRoute;

                ui.refs.phase.textContent = phaseText();
                ui.refs.phaseWrap.setAttribute(
                    'aria-busy',
                    state.phase === 'waiting' ||
                        state.phase === 'probing'
                        ? 'true'
                        : 'false'
                );
                ui.refs.autoProbe.checked = state.autoProbe;
                ui.refs.autoProbe.disabled = !state.enabled;
                ui.refs.retest.disabled =
                    !!state.probePromise ||
                    !state.enabled ||
                    !state.currentPlan.length;
                ui.refs.retest.textContent =
                    state.phase === 'probing'
                        ? '测速进行中'
                        : state.phase === 'waiting'
                          ? '等待安全窗口'
                          : '重新测速';
            }

            function mountControlUi() {
                if (
                    ui.mounted ||
                    !root.document?.documentElement ||
                    typeof root.document.createElement !== 'function'
                ) {
                    return;
                }

                const host = root.document.createElement('div');
                host.id = 'kota-bili-auto-cdn-control';
                Object.assign(host.style, {
                    all: 'initial',
                    position: 'fixed',
                    right: '18px',
                    bottom: '72px',
                    width: `${UI_LAUNCHER_SIZE}px`,
                    height: `${UI_LAUNCHER_SIZE}px`,
                    zIndex: '2147483647',
                    pointerEvents: 'none'
                });
                const shadow = host.attachShadow({ mode: 'open' });
                shadow.innerHTML = `
                    <style>
                        :host {
                            color-scheme: dark;
                            --cyan: #00aeec;
                            --cyan-soft: rgba(0, 174, 236, .16);
                            --ink: rgba(18, 21, 27, .97);
                            --line: rgba(255, 255, 255, .12);
                            --muted: #929aa8;
                            --text: #f2f5f8;
                            --amber: #f2b84b;
                            --red: #ff6b70;
                            font-family: -apple-system, BlinkMacSystemFont,
                                "PingFang SC", "Segoe UI", sans-serif;
                            font-size: 13px;
                            line-height: 1.4;
                        }
                        *, *::before, *::after { box-sizing: border-box; }
                        [hidden] { display: none !important; }
                        button, input { font: inherit; }
                        button { -webkit-tap-highlight-color: transparent; }
                        button:focus-visible, input:focus-visible + .route__marker {
                            outline: 2px solid var(--cyan);
                            outline-offset: 2px;
                        }
                        .launcher {
                            width: 30px;
                            height: 30px;
                            min-height: 0;
                            display: grid;
                            place-items: center;
                            margin-left: auto;
                            padding: 0;
                            border: 0;
                            border-radius: 50%;
                            color: #fff;
                            background: transparent;
                            box-shadow: none;
                            cursor: grab;
                            pointer-events: auto;
                            touch-action: none;
                            user-select: none;
                            -webkit-user-select: none;
                        }
                        .launcher--dragging {
                            cursor: grabbing;
                        }
                        .launcher__dot {
                            width: 16px;
                            height: 16px;
                            display: grid;
                            place-items: center;
                            border-radius: 50%;
                            border: 1px solid rgba(255, 255, 255, .7);
                            background: rgba(0, 174, 236, .68);
                            box-shadow:
                                0 0 0 1px rgba(6, 16, 24, .55),
                                0 3px 11px rgba(0, 0, 0, .3);
                            transition:
                                width 140ms ease,
                                height 140ms ease,
                                filter 140ms ease,
                                background 140ms ease;
                        }
                        .launcher:hover .launcher__dot,
                        .launcher:focus-visible .launcher__dot,
                        .launcher[aria-expanded="true"] .launcher__dot {
                            width: 20px;
                            height: 20px;
                            filter: brightness(1.15);
                        }
                        .launcher__bolt {
                            width: 8px;
                            height: 11px;
                            fill: currentColor;
                            opacity: .94;
                            pointer-events: none;
                        }
                        .launcher[data-phase="waiting"] .launcher__dot {
                            background: rgba(242, 184, 75, .72);
                        }
                        .launcher[data-phase="probing"] .launcher__dot {
                            animation: pulse 1.1s ease-in-out infinite;
                        }
                        .launcher[data-phase="failed"] .launcher__dot,
                        .launcher[data-phase="error"] .launcher__dot {
                            background: rgba(255, 107, 112, .72);
                        }
                        .launcher[data-phase="off"] .launcher__dot {
                            background: rgba(115, 123, 136, .62);
                        }
                        .panel {
                            position: absolute;
                            left: 0;
                            top: 36px;
                            width: min(370px, calc(100vw - 24px));
                            max-height: min(650px, 76vh);
                            overflow: auto;
                            border: 1px solid rgba(255, 255, 255, .15);
                            border-radius: 14px;
                            color: var(--text);
                            background: var(--ink);
                            box-shadow:
                                0 22px 70px rgba(0, 0, 0, .44),
                                inset 0 1px rgba(255, 255, 255, .04);
                            backdrop-filter: blur(18px);
                            pointer-events: auto;
                            scrollbar-width: thin;
                            scrollbar-color: #4b5360 transparent;
                            transform-origin: right bottom;
                            animation: panel-in 140ms ease-out;
                        }
                        .instrument {
                            display: flex;
                            justify-content: space-between;
                            padding: 10px 14px 6px;
                            color: #697383;
                            font: 600 9px/1.2 "SFMono-Regular", Consolas,
                                monospace;
                            letter-spacing: .15em;
                        }
                        .panel__head {
                            display: flex;
                            align-items: center;
                            gap: 10px;
                            padding: 5px 14px 12px;
                            border-bottom: 1px solid var(--line);
                        }
                        .title { min-width: 0; flex: 1; }
                        .title h2 {
                            margin: 0;
                            font-size: 18px;
                            line-height: 1.25;
                            letter-spacing: -.02em;
                        }
                        .auto-probe {
                            display: inline-flex;
                            align-items: center;
                            flex: 0 0 auto;
                            gap: 6px;
                            min-height: 28px;
                            color: #aab1bc;
                            cursor: pointer;
                            font-size: 10px;
                            white-space: nowrap;
                        }
                        .auto-probe:has(input:disabled) {
                            cursor: not-allowed;
                            opacity: .45;
                        }
                        .auto-probe input {
                            position: absolute;
                            width: 1px;
                            height: 1px;
                            opacity: 0;
                            pointer-events: none;
                        }
                        .auto-probe input:focus-visible +
                            .auto-probe__track {
                            outline: 2px solid var(--cyan);
                            outline-offset: 2px;
                        }
                        .auto-probe__track {
                            width: 28px;
                            height: 16px;
                            padding: 2px;
                            border: 1px solid rgba(255, 255, 255, .16);
                            border-radius: 999px;
                            background: #303641;
                            transition: background 120ms ease;
                        }
                        .auto-probe__knob {
                            display: block;
                            width: 10px;
                            height: 10px;
                            border-radius: 50%;
                            background: #a5acb7;
                            transition: transform 120ms ease,
                                background 120ms ease;
                        }
                        .auto-probe input:checked + .auto-probe__track {
                            border-color: rgba(0, 174, 236, .55);
                            background: var(--cyan-soft);
                        }
                        .auto-probe input:checked +
                            .auto-probe__track .auto-probe__knob {
                            transform: translateX(12px);
                            background: var(--cyan);
                        }
                        .close {
                            width: 28px;
                            height: 28px;
                            border: 0;
                            border-radius: 7px;
                            color: #8c95a2;
                            background: transparent;
                            cursor: pointer;
                            font-size: 20px;
                            line-height: 1;
                        }
                        .close:hover { color: #fff; background: #2b3039; }
                        .section-label {
                            display: flex;
                            justify-content: space-between;
                            margin: 11px 14px 6px;
                            color: #737d8b;
                            font: 650 9px/1.3 "SFMono-Regular", Consolas,
                                monospace;
                            letter-spacing: .12em;
                            text-transform: uppercase;
                        }
                        .route-list { padding: 0 8px; }
                        .route {
                            position: relative;
                            display: flex;
                            align-items: flex-start;
                            gap: 10px;
                            min-height: 54px;
                            padding: 8px 7px;
                            border-radius: 9px;
                            cursor: pointer;
                        }
                        .route:hover { background: rgba(255, 255, 255, .045); }
                        .route:has(input:checked) {
                            background: rgba(0, 174, 236, .075);
                        }
                        .route--disabled {
                            cursor: not-allowed;
                            opacity: .48;
                        }
                        .route input {
                            position: absolute;
                            width: 1px;
                            height: 1px;
                            opacity: 0;
                        }
                        .route__marker {
                            flex: 0 0 auto;
                            width: 15px;
                            height: 15px;
                            margin-top: 2px;
                            border: 1px solid #5d6673;
                            border-radius: 50%;
                        }
                        .route input:checked + .route__marker {
                            border: 4px solid var(--cyan);
                            background: #fff;
                        }
                        .route__body {
                            display: block;
                            min-width: 0;
                            flex: 1;
                        }
                        .route__top, .route__bottom {
                            display: flex;
                            align-items: baseline;
                            justify-content: space-between;
                            gap: 8px;
                        }
                        .route__name {
                            color: #edf1f5;
                            font-size: 12px;
                            font-weight: 650;
                        }
                        .route__metrics {
                            color: #a8b0bc;
                            font: 10px/1.35 "SFMono-Regular", Consolas,
                                monospace;
                            font-variant-numeric: tabular-nums;
                            text-align: right;
                        }
                        .route__bottom { margin-top: 3px; }
                        .route__meta {
                            min-width: 0;
                            overflow: hidden;
                            color: #666f7d;
                            font: 9px/1.35 "SFMono-Regular", Consolas,
                                monospace;
                            text-overflow: ellipsis;
                            white-space: nowrap;
                        }
                        .route__badges {
                            display: inline-flex;
                            flex: 0 0 auto;
                            gap: 4px;
                        }
                        .badge {
                            padding: 1px 4px;
                            border: 1px solid #424a56;
                            border-radius: 4px;
                            color: #89929f;
                            font: 600 8px/1.35 "SFMono-Regular", Consolas,
                                monospace;
                        }
                        .badge--current {
                            border-color: rgba(0, 174, 236, .35);
                            color: #52c8f2;
                        }
                        .pending {
                            margin: 8px 14px 4px;
                            padding: 10px;
                            border: 1px solid rgba(0, 174, 236, .28);
                            border-radius: 9px;
                            background: rgba(0, 174, 236, .07);
                        }
                        .pending p {
                            margin: 0 0 9px;
                            color: #c4d4dc;
                            font-size: 11px;
                        }
                        .pending__actions {
                            display: flex;
                            justify-content: flex-end;
                            gap: 7px;
                        }
                        .button {
                            min-height: 29px;
                            padding: 5px 10px;
                            border: 1px solid #414956;
                            border-radius: 7px;
                            color: #cbd2db;
                            background: #272c34;
                            cursor: pointer;
                            font-size: 11px;
                            font-weight: 620;
                        }
                        .button:hover:not(:disabled) {
                            border-color: #626c7a;
                            background: #303640;
                        }
                        .button--primary {
                            border-color: var(--cyan);
                            color: #06151c;
                            background: var(--cyan);
                        }
                        .button--primary:hover:not(:disabled) {
                            border-color: #39c5f5;
                            background: #39c5f5;
                        }
                        .button:disabled {
                            cursor: not-allowed;
                            opacity: .45;
                        }
                        .footer {
                            display: flex;
                            align-items: center;
                            gap: 10px;
                            margin-top: 10px;
                            padding: 11px 14px 13px;
                            border-top: 1px solid var(--line);
                        }
                        .footer__status { min-width: 0; flex: 1; }
                        .footer__phase {
                            margin: 0;
                            color: #b2bac5;
                            font-size: 10px;
                        }
                        .sr-only {
                            position: absolute;
                            width: 1px;
                            height: 1px;
                            padding: 0;
                            margin: -1px;
                            overflow: hidden;
                            clip: rect(0, 0, 0, 0);
                            white-space: nowrap;
                            border: 0;
                        }
                        @keyframes panel-in {
                            from { opacity: 0; transform: translateY(5px); }
                            to { opacity: 1; transform: translateY(0); }
                        }
                        @keyframes pulse {
                            50% { opacity: .4; transform: scale(.75); }
                        }
                        @media (prefers-reduced-motion: reduce) {
                            *, *::before, *::after {
                                animation-duration: .01ms !important;
                                transition-duration: .01ms !important;
                            }
                        }
                        @media (max-width: 520px) {
                            .panel {
                                width: calc(100vw - 24px);
                            }
                        }
                    </style>
                    <section class="panel" id="kota-cdn-panel"
                        data-ref="panel" role="dialog"
                        aria-labelledby="kota-cdn-title" hidden>
                        <div class="instrument">
                            <span>Bilibili Accelerator</span>
                            <span>V${VERSION}</span>
                        </div>
                        <header class="panel__head">
                            <div class="title">
                                <h2 id="kota-cdn-title">
                                    切换B站视频线路
                                </h2>
                            </div>
                            <button class="close" data-ref="close"
                                type="button" aria-label="收起面板">×</button>
                        </header>
                        <div class="section-label">
                            <span>ROUTING MODE</span><span>刷新后生效</span>
                        </div>
                        <div class="route-list" data-ref="routeList"
                            role="radiogroup" aria-label="视频 CDN 线路"></div>
                        <div class="pending" data-ref="pending" hidden>
                            <p data-ref="pendingText"></p>
                            <div class="pending__actions">
                                <button class="button" data-ref="cancel"
                                    type="button">取消</button>
                                <button class="button button--primary"
                                    data-ref="apply" type="button">
                                    刷新并应用
                                </button>
                            </div>
                        </div>
                        <footer class="footer">
                            <div class="footer__status" data-ref="phaseWrap">
                                <p class="footer__phase"
                                    data-ref="phase"></p>
                            </div>
                            <label class="auto-probe">
                                <span>自动测速</span>
                                <input data-ref="autoProbe" type="checkbox"
                                    aria-label="自动后台测速">
                                <span class="auto-probe__track">
                                    <span class="auto-probe__knob"></span>
                                </span>
                            </label>
                            <button class="button" data-ref="retest"
                                type="button">重新测速</button>
                        </footer>
                    </section>
                    <button class="launcher" data-ref="launcher" type="button"
                        aria-label="打开视频线路控制面板"
                        title="拖动移动；点击打开线路面板"
                        aria-expanded="false" aria-controls="kota-cdn-panel">
                        <span class="launcher__dot" aria-hidden="true">
                            <svg class="launcher__bolt" viewBox="0 0 12 16"
                                focusable="false">
                                <path d="M5.65 0h5.6l-3.5 6h3.5l-8.8 10
                                    2.5-7h-3.7z"/>
                            </svg>
                        </span>
                    </button>
                    <div class="sr-only" data-ref="live"
                        aria-live="polite"></div>
                `;

                ui.host = host;
                ui.shadow = shadow;
                ui.refs = Object.fromEntries(
                    [...shadow.querySelectorAll('[data-ref]')].map(element => [
                        element.dataset.ref,
                        element
                    ])
                );
                ui.mounted = true;
                buildRouteRows();
                ui.preferredPosition = loadUiPosition();
                applyUiPosition(ui.preferredPosition);

                ui.refs.launcher.addEventListener(
                    'pointerdown',
                    beginLauncherDrag
                );
                ui.refs.launcher.addEventListener(
                    'pointermove',
                    moveLauncherDrag
                );
                ui.refs.launcher.addEventListener(
                    'pointerup',
                    event => endLauncherDrag(event)
                );
                ui.refs.launcher.addEventListener(
                    'pointercancel',
                    event => endLauncherDrag(event, true)
                );
                ui.refs.launcher.addEventListener(
                    'lostpointercapture',
                    event => endLauncherDrag(event, true)
                );
                ui.refs.launcher.addEventListener(
                    'click',
                    handleLauncherClick
                );
                ui.refs.close.addEventListener('click', () =>
                    setUiOpen(false, true)
                );
                ui.refs.cancel.addEventListener('click', () => {
                    ui.pendingRoute = '';
                    renderUi();
                });
                ui.refs.apply.addEventListener('click', () => {
                    if (ui.pendingRoute) {
                        saveRouteAndReload(ui.pendingRoute);
                    }
                });
                ui.refs.retest.addEventListener(
                    'click',
                    clearCurrentHealthAndRetest
                );
                ui.refs.autoProbe.addEventListener('change', () =>
                    setAutoProbeEnabled(ui.refs.autoProbe.checked)
                );
                root.document.addEventListener('keydown', event => {
                    if (event.key === 'Escape' && ui.open) {
                        setUiOpen(false, true);
                    }
                });
                root.document.addEventListener(
                    'fullscreenchange',
                    moveUiForFullscreen
                );
                root.addEventListener('resize', () =>
                    applyUiPosition(
                        ui.preferredPosition || ui.position
                    )
                );
                root.addEventListener('orientationchange', () =>
                    applyUiPosition(
                        ui.preferredPosition || ui.position
                    )
                );
                root.visualViewport?.addEventListener?.(
                    'resize',
                    () =>
                        applyUiPosition(
                            ui.preferredPosition || ui.position
                        )
                );
                root.visualViewport?.addEventListener?.(
                    'scroll',
                    () =>
                        applyUiPosition(
                            ui.preferredPosition || ui.position
                        )
                );

                root.document.documentElement.appendChild(host);
                renderUi();
                if (
                    !ui.ageTimer &&
                    typeof root.setInterval === 'function'
                ) {
                    ui.ageTimer = root.setInterval(() => {
                        if (ui.open) {
                            renderUi();
                        }
                    }, 60 * 1000);
                }
            }

            function moveUiForFullscreen() {
                if (!ui.host || !root.document?.documentElement) {
                    return;
                }
                if (ui.drag) {
                    const drag = ui.drag;
                    ui.drag = null;
                    ui.refs.launcher.classList.remove(
                        'launcher--dragging'
                    );
                    try {
                        ui.refs.launcher.releasePointerCapture(
                            drag.pointerId
                        );
                    } catch (_) {}
                    if (drag.moved) {
                        ui.preferredPosition = ui.position;
                        saveUiPosition(ui.position);
                        ui.suppressLauncherClickUntil =
                            Date.now() + 500;
                    }
                }
                const fullscreen = root.document.fullscreenElement;
                const target =
                    fullscreen &&
                    String(fullscreen.tagName || '').toLowerCase() !==
                        'video'
                        ? fullscreen
                        : root.document.documentElement;
                if (ui.host.parentNode !== target) {
                    target.appendChild(ui.host);
                }
                applyUiPosition(
                    ui.preferredPosition || ui.position
                );
            }

            function mountControlUiSoon() {
                if (root.document?.documentElement) {
                    mountControlUi();
                } else {
                    root.addEventListener(
                        'DOMContentLoaded',
                        mountControlUi,
                        { once: true }
                    );
                }
            }

            function observeMediaRequest(rawUrl, fromResourceObserver = false) {
                if (!isObservableMediaRequest(rawUrl)) {
                    return;
                }
                if (
                    fromResourceObserver &&
                    state.probeResourceCounts.has(rawUrl)
                ) {
                    return;
                }
                const host = hostOf(rawUrl);
                if (!host || host === state.observedHost) {
                    return;
                }
                state.observedHost = host;
                renderUi();
            }

            function startResourceObserver() {
                if (typeof root.PerformanceObserver !== 'function') {
                    return;
                }
                try {
                    const observer = new root.PerformanceObserver(list => {
                        for (const entry of list.getEntries()) {
                            observeMediaRequest(entry.name, true);
                        }
                    });
                    observer.observe({ type: 'resource', buffered: true });
                } catch (_) {
                    // Fetch/XHR observation still covers normal player traffic.
                }
            }

            function processPayloadObject(payload, source) {
                if (!state.enabled || !payload || typeof payload !== 'object') {
                    return {
                        payload,
                        changed: false,
                        entryCount: 0,
                        probePlan: [],
                        availableHosts: [],
                        nativeAkamaiAvailable: false
                    };
                }

                const result = transformPlayInfo(
                    payload,
                    state.health,
                    Date.now(),
                    {
                        mode: state.mode,
                        manualTarget: state.manualTarget
                    }
                );

                if (!result.entryCount) {
                    return result;
                }

                state.lastSource = source;
                state.lastWinner = result.winnerHost;
                state.currentPlan = result.probePlan.slice();
                state.availableHosts = result.availableHosts.slice();
                state.nativeAkamaiAvailable =
                    result.nativeAkamaiAvailable;
                state.manualMatched = result.manualMatched;
                state.manualMissed = result.manualMissed;
                state.benchmarkWinner = bestHealthyHost(
                    state.currentPlan.map(route => route.host)
                );
                if (state.mode === 'manual') {
                    state.phase = 'idle';
                    state.phaseNote = result.manualMissed
                        ? result.manualMatched
                            ? `手动线路命中 ${result.manualMatched} 条；${result.manualMissed} 条保留原始`
                            : '本视频没有该手动线路；已保留原始地址'
                        : `手动线路已应用到 ${result.manualMatched} 条媒体`;
                }
                renderUi();

                scheduleProbe(
                    result.probePlan,
                    false,
                    result.winnerHost
                );
                return result;
            }

            function processPayloadText(text, source) {
                if (
                    typeof text !== 'string' ||
                    !(
                        text.includes('bilivideo') ||
                        text.includes('akamaized.net')
                    )
                ) {
                    return { text, changed: false };
                }

                try {
                    const payload = nativeJsonParse(text);
                    const result = processPayloadObject(payload, source);
                    return {
                        text: result.changed
                            ? nativeJsonStringify(payload)
                            : text,
                        changed: result.changed
                    };
                } catch (_) {
                    return { text, changed: false };
                }
            }

            function markProbeResource(rawUrl) {
                state.probeResourceCounts.set(
                    rawUrl,
                    (state.probeResourceCounts.get(rawUrl) || 0) + 1
                );
            }

            function unmarkProbeResource(rawUrl) {
                const remaining =
                    (state.probeResourceCounts.get(rawUrl) || 0) - 1;
                if (remaining > 0) {
                    state.probeResourceCounts.set(rawUrl, remaining);
                } else {
                    state.probeResourceCounts.delete(rawUrl);
                }
            }

            async function probeOnce(route, range) {
                const controller =
                    typeof root.AbortController === 'function'
                        ? new root.AbortController()
                        : null;
                const started = root.performance.now();
                let timedOut = false;
                markProbeResource(route.url);
                const timer = root.setTimeout(() => {
                    timedOut = true;
                    controller?.abort();
                }, PROBE_TIMEOUT_MS);

                try {
                    const response = await nativeFetch.call(root, route.url, {
                        method: 'GET',
                        mode: 'cors',
                        cache: 'no-store',
                        credentials: 'omit',
                        redirect: 'follow',
                        headers: {
                            Range: `bytes=${range[0]}-${range[1]}`
                        },
                        signal: controller?.signal
                    });
                    const ttfbMs = root.performance.now() - started;

                    // A large 200 means Range was ignored. Aborting that rare
                    // response is safer than silently downloading a whole video.
                    if (response.status !== 206) {
                        controller?.abort();
                        return {
                            ok: false,
                            status: response.status,
                            bytes: 0,
                            ttfbMs,
                            totalMs: timedOut
                                ? PROBE_TIMEOUT_MS
                                : root.performance.now() - started,
                            mbps: 0
                        };
                    }

                    // Read the complete small Range. We intentionally do not
                    // cancel a successful response, avoiding an abort/RST storm.
                    const body = await response.arrayBuffer();
                    const totalMs = root.performance.now() - started;
                    const bytes = body.byteLength;
                    const transferMs = Math.max(1, totalMs - ttfbMs);
                    const mbps =
                        bytes > 0
                            ? (bytes * 8) / 1e6 / (transferMs / 1000)
                            : 0;

                    return {
                        ok: bytes >= Math.min(64 * 1024, PROBE_BYTES),
                        status: response.status,
                        bytes,
                        ttfbMs,
                        totalMs,
                        mbps
                    };
                } catch (_) {
                    return {
                        ok: false,
                        status: 0,
                        bytes: 0,
                        ttfbMs: 0,
                        totalMs: timedOut
                            ? PROBE_TIMEOUT_MS
                            : root.performance.now() - started,
                        mbps: 0
                    };
                } finally {
                    root.clearTimeout(timer);
                    // Resource Timing delivery trails fetch completion slightly.
                    // Keep the marker long enough that our own test request is
                    // never presented as the player's "actual" CDN.
                    root.setTimeout(
                        () => unmarkProbeResource(route.url),
                        2000
                    );
                }
            }

            function probePlanKey(plan) {
                return (plan || [])
                    .map(route => `${route.host}\n${route.url}`)
                    .sort()
                    .join('\n---\n');
            }

            function isCurrentProbe(generation) {
                return (
                    generation === state.probeGeneration &&
                    generation === state.activeProbeGeneration
                );
            }

            async function runProbe(plan, work, generation) {
                if (!isCurrentProbe(generation)) {
                    return;
                }
                const routes = uniqueProbeRoutes(plan);
                if (!routes.length) {
                    return;
                }

                if (!isCurrentProbe(generation)) {
                    return;
                }
                state.phase = 'waiting';
                state.phaseNote = '';
                state.probeProgress = null;
                renderUi();
                const playbackReady =
                    await waitForProbeWindow(generation);
                if (!isCurrentProbe(generation)) {
                    return;
                }
                if (!playbackReady) {
                    log('播放器尚未形成缓冲，本页跳过后台测速');
                    state.phase = 'idle';
                    state.phaseNote = '没有足够缓冲，本页跳过测速';
                    renderUi();
                    return;
                }

                state.phase = 'probing';
                announce('CDN 测速开始');
                renderUi();

                let routesToProbe =
                    work.kind === 'full'
                        ? routes
                        : uniqueProbeRoutes(work.routes);
                let promotedToFull = work.kind === 'full';

                if (work.verifyRoute) {
                    const verifyRoute =
                        routes.find(
                            route =>
                                route.host === work.verifyRoute.host
                        ) || work.verifyRoute;
                    if (!hasSafeProbeWindow()) {
                        log('缓冲下降或正在 seek，停止轻量复核');
                        state.phase = 'idle';
                        state.phaseNote = '缓冲下降，轻量复核已中止';
                        state.probeProgress = null;
                        renderUi();
                        return;
                    }
                    state.probeProgress = {
                        host: verifyRoute.host,
                        hostIndex: 1,
                        hostTotal: 1,
                        rangeIndex: 1,
                        rangeTotal: 1,
                        verification: true
                    };
                    renderUi();
                    const baseline = state.health[verifyRoute.host];
                    const verification = await probeOnce(
                        verifyRoute,
                        PROBE_RANGES[0]
                    );
                    if (!isCurrentProbe(generation)) {
                        return;
                    }

                    if (
                        baseline &&
                        isVerificationAcceptable(
                            verification,
                            baseline
                        )
                    ) {
                        baseline.verifiedAt = Date.now();
                        saveHealth();
                        log('轻量复核通过', {
                            host: verifyRoute.host,
                            totalMs: Number(
                                verification.totalMs.toFixed(0)
                            ),
                            limitMs: Number(
                                verificationLimitMs(baseline).toFixed(0)
                            )
                        });
                    } else {
                        promotedToFull = true;
                        routesToProbe = routes;
                        state.phaseNote =
                            '轻量复核未通过，重新测试全部线路';
                        log('轻量复核未通过，升级为完整测速', {
                            host: verifyRoute.host,
                            ok: verification.ok,
                            totalMs: Number(
                                (verification.totalMs || 0).toFixed(0)
                            ),
                            limitMs: Number(
                                verificationLimitMs(baseline).toFixed(0)
                            )
                        });
                    }
                }

                if (!routesToProbe.length) {
                    state.benchmarkWinner = bestHealthyHost(
                        routes.map(route => route.host)
                    );
                    state.phase = state.benchmarkWinner
                        ? 'ready'
                        : 'failed';
                    state.phaseNote = '';
                    state.probeProgress = null;
                    renderUi();
                    return;
                }

                const samples = new Map(
                    routesToProbe.map(route => [route.host, []])
                );

                // Serial rounds avoid competing with the video's own startup
                // traffic. Reversing round two reduces ordering bias.
                for (
                    let index = 0;
                    index < routesToProbe.length;
                    index += 1
                ) {
                    const route = routesToProbe[index];
                    if (!isCurrentProbe(generation)) {
                        return;
                    }
                    if (!hasSafeProbeWindow()) {
                        log('缓冲下降或正在 seek，停止剩余测速');
                        state.phase = 'idle';
                        state.phaseNote = '缓冲下降，测速已中止';
                        state.probeProgress = null;
                        renderUi();
                        return;
                    }
                    state.probeProgress = {
                        host: route.host,
                        hostIndex: index + 1,
                        hostTotal: routesToProbe.length,
                        rangeIndex: 1,
                        rangeTotal: 2,
                        verification: false
                    };
                    renderUi();
                    samples
                        .get(route.host)
                        .push(await probeOnce(route, PROBE_RANGES[0]));
                }
                await new Promise(resolve => root.setTimeout(resolve, 1200));
                if (!isCurrentProbe(generation)) {
                    return;
                }
                const reversed = routesToProbe.slice().reverse();
                for (
                    let index = 0;
                    index < reversed.length;
                    index += 1
                ) {
                    const route = reversed[index];
                    if (!isCurrentProbe(generation)) {
                        return;
                    }
                    if (!hasSafeProbeWindow()) {
                        log('缓冲下降或正在 seek，停止剩余测速');
                        state.phase = 'idle';
                        state.phaseNote = '缓冲下降，测速已中止';
                        state.probeProgress = null;
                        renderUi();
                        return;
                    }
                    state.probeProgress = {
                        host: route.host,
                        hostIndex: index + 1,
                        hostTotal: routesToProbe.length,
                        rangeIndex: 2,
                        rangeTotal: 2,
                        verification: false
                    };
                    renderUi();
                    samples
                        .get(route.host)
                        .push(await probeOnce(route, PROBE_RANGES[1]));
                }

                if (!isCurrentProbe(generation)) {
                    return;
                }
                const sampledAt = Date.now();
                const records = routesToProbe.map(route =>
                    aggregateProbeSamples(
                        route.host,
                        samples.get(route.host),
                        sampledAt
                    )
                );
                for (const record of records) {
                    state.health[record.host] = record;
                }
                state.lastProbeAt = sampledAt;
                saveHealth();

                state.benchmarkWinner = bestHealthyHost(
                    routes.map(route => route.host)
                );
                if (state.benchmarkWinner) {
                    state.phase = 'ready';
                    state.phaseNote = '';
                    state.probeProgress = null;
                    log(
                        promotedToFull
                            ? '完整测速完成'
                            : '过期线路测速完成',
                        records.map(record => ({
                            host: record.host,
                            success: `${record.successes}/${record.attempts}`,
                            Mbps: Number(record.medianMbps.toFixed(1)),
                            TTFB: Number(record.medianTtfbMs.toFixed(0)),
                            worstMs: Number(record.worstMs.toFixed(0))
                        }))
                    );
                } else {
                    state.phase = 'failed';
                    state.phaseNote = '';
                    state.probeProgress = null;
                    log('测速全部失败，保留 B站原始主备地址');
                }
                renderUi();
            }

            async function waitForProbeWindow(generation) {
                const started = Date.now();
                const maxWaitMs = 30 * 1000;

                while (Date.now() - started < maxWaitMs) {
                    if (!isCurrentProbe(generation)) {
                        return false;
                    }
                    if (hasSafeProbeWindow()) {
                        return true;
                    }
                    await new Promise(resolve =>
                        root.setTimeout(resolve, 1000)
                    );
                }
                return false;
            }

            function hasSafeProbeWindow() {
                if (root.document?.hidden) {
                    return false;
                }
                const video = root.document?.querySelector?.('video');
                if (!video || video.seeking || video.readyState < 2) {
                    return false;
                }
                if (video.paused) {
                    return true;
                }

                let bufferedAhead = 0;
                try {
                    for (
                        let index = 0;
                        index < video.buffered.length;
                        index += 1
                    ) {
                        if (
                            video.buffered.start(index) <= video.currentTime &&
                            video.buffered.end(index) >= video.currentTime
                        ) {
                            bufferedAhead = Math.max(
                                bufferedAhead,
                                video.buffered.end(index) - video.currentTime
                            );
                        }
                    }
                } catch (_) {
                    return false;
                }

                // Leave enough runway for one slow timeout without consuming
                // the player's visible buffer.
                return video.readyState >= 3 && bufferedAhead >= 15;
            }

            function scheduleProbe(
                plan,
                force = false,
                preferredHost = ''
            ) {
                if (
                    !state.enabled ||
                    (!force && !state.autoProbe) ||
                    !Array.isArray(plan) ||
                    !plan.length
                ) {
                    return;
                }

                const planCopy = plan.map(route => ({ ...route }));
                const key = `${preferredHost}\n${probePlanKey(planCopy)}`;
                if (state.probePromise) {
                    if (
                        key === state.pendingProbe?.key ||
                        (key === state.activeProbeKey &&
                            !state.pendingProbe &&
                            isCurrentProbe(
                                state.activeProbeGeneration
                            ))
                    ) {
                        return;
                    }
                    // A SPA navigation can deliver a new signed playurl while
                    // the previous video's safe-window wait/test is active.
                    // Invalidate its UI writes and retain only the latest plan.
                    state.probeGeneration += 1;
                    state.pendingProbe = {
                        plan: planCopy,
                        force,
                        preferredHost,
                        key
                    };
                    state.phase = 'waiting';
                    state.phaseNote = '视频已切换，等待重新测速';
                    state.probeProgress = null;
                    renderUi();
                    return;
                }

                const now = Date.now();
                const work = planProbeWork(
                    planCopy,
                    state.health,
                    now,
                    preferredHost,
                    force
                );
                if (work.kind === 'none') {
                    state.benchmarkWinner = bestHealthyHost(
                        planCopy.map(route => route.host)
                    );
                    state.phase = state.benchmarkWinner
                        ? 'ready'
                        : 'failed';
                    state.phaseNote = '';
                    renderUi();
                    return;
                }

                const generation = ++state.probeGeneration;
                state.activeProbeGeneration = generation;
                state.activeProbeKey = key;
                state.activeProbeForced = force;
                state.phase = 'waiting';
                state.phaseNote = '';
                renderUi();
                state.probePromise = new Promise(resolve => {
                    root.setTimeout(resolve, PROBE_DELAY_MS);
                })
                    .then(() => runProbe(planCopy, work, generation))
                    .catch(error => {
                        if (isCurrentProbe(generation)) {
                            state.benchmarkWinner = bestHealthyHost(
                                planCopy.map(route => route.host)
                            );
                            state.phase = state.benchmarkWinner
                                ? 'ready'
                                : 'failed';
                            state.phaseNote =
                                state.benchmarkWinner
                                    ? '后台复核异常；继续沿用缓存'
                                    : '测速异常；已保留原始线路';
                            state.probeProgress = null;
                            renderUi();
                        }
                        log('后台测速异常，保留原始线路', error?.message || error);
                    })
                    .finally(() => {
                        if (
                            state.activeProbeGeneration === generation
                        ) {
                            state.probePromise = null;
                            state.activeProbeGeneration = 0;
                            state.activeProbeKey = '';
                            state.activeProbeForced = false;
                        }
                        const pending = state.pendingProbe;
                        state.pendingProbe = null;
                        if (pending) {
                            scheduleProbe(
                                pending.plan,
                                pending.force,
                                pending.preferredHost
                            );
                        } else {
                            renderUi();
                        }
                    });
            }

            function cloneResponseWithText(response, text) {
                const headers = new NativeHeaders(response.headers);
                headers.delete('content-length');
                headers.delete('content-encoding');
                const rewritten = new NativeResponse(text, {
                    status: response.status,
                    statusText: response.statusText,
                    headers
                });

                // Some player code inspects these metadata properties. They are
                // best-effort only; failure leaves a valid Response object.
                for (const key of ['url', 'redirected', 'type']) {
                    try {
                        Object.defineProperty(rewritten, key, {
                            configurable: true,
                            value: response[key]
                        });
                    } catch (_) {}
                }
                return rewritten;
            }

            root.fetch = function patchedFetch(input, init) {
                const rawUrl = requestUrlOf(input);
                observeMediaRequest(rawUrl);
                const promise = nativeFetch.apply(this, arguments);
                if (!state.enabled || !isPlayUrlApi(rawUrl)) {
                    return promise;
                }

                return promise
                    .then(async response => {
                        try {
                            const originalText = await response.clone().text();
                            const transformed = processPayloadText(
                                originalText,
                                'fetch'
                            );
                            return transformed.changed
                                ? cloneResponseWithText(
                                      response,
                                      transformed.text
                                  )
                                : response;
                        } catch (_) {
                            return response;
                        }
                    })
                    .catch(error => {
                        throw error;
                    });
            };

            class PatchedXMLHttpRequest extends NativeXHR {
                constructor() {
                    super();
                    this.__biliAutoCdn = {
                        url: '',
                        textDone: false,
                        text: '',
                        jsonDone: false,
                        json: null
                    };
                }

                open(method, url, ...rest) {
                    this.__biliAutoCdn = {
                        url: requestUrlOf(url),
                        textDone: false,
                        text: '',
                        jsonDone: false,
                        json: null
                    };
                    observeMediaRequest(this.__biliAutoCdn.url);
                    return super.open(method, url, ...rest);
                }

                get responseText() {
                    const original = super.responseText;
                    if (
                        !state.enabled ||
                        this.readyState !== 4 ||
                        !isPlayUrlApi(this.__biliAutoCdn?.url)
                    ) {
                        return original;
                    }

                    if (!this.__biliAutoCdn.textDone) {
                        this.__biliAutoCdn.text =
                            processPayloadText(original, 'xhr').text;
                        this.__biliAutoCdn.textDone = true;
                    }
                    return this.__biliAutoCdn.text;
                }

                get response() {
                    const original = super.response;
                    if (
                        !state.enabled ||
                        this.readyState !== 4 ||
                        !isPlayUrlApi(this.__biliAutoCdn?.url)
                    ) {
                        return original;
                    }

                    if (this.responseType === 'json') {
                        if (!this.__biliAutoCdn.jsonDone) {
                            this.__biliAutoCdn.json =
                                processPayloadObject(original, 'xhr-json')
                                    .payload;
                            this.__biliAutoCdn.jsonDone = true;
                        }
                        return this.__biliAutoCdn.json;
                    }

                    if (
                        this.responseType === '' ||
                        this.responseType === 'text'
                    ) {
                        return this.responseText;
                    }
                    return original;
                }
            }

            root.XMLHttpRequest = PatchedXMLHttpRequest;

            function patchGlobalPlayInfo(name) {
                const existing = Object.getOwnPropertyDescriptor(root, name);

                // Do not replace an accessor installed by Bilibili or another
                // extension. Fetch/XHR interception still covers future API
                // responses, and an object returned by its getter can be safely
                // transformed in place once.
                if (existing && (existing.get || existing.set)) {
                    try {
                        const current = existing.get?.call(root);
                        if (current && typeof current === 'object') {
                            processPayloadObject(current, name);
                        }
                    } catch (_) {}
                    return;
                }

                if (existing && existing.configurable === false) {
                    if (root[name] && typeof root[name] === 'object') {
                        processPayloadObject(root[name], name);
                    }
                    return;
                }

                let value =
                    existing && 'value' in existing
                        ? processPayloadObject(existing.value, name).payload
                        : undefined;

                try {
                    Object.defineProperty(root, name, {
                        configurable: true,
                        enumerable: true,
                        get() {
                            return value;
                        },
                        set(nextValue) {
                            value = processPayloadObject(
                                nextValue,
                                name
                            ).payload;
                        }
                    });
                } catch (_) {
                    if (root[name] && typeof root[name] === 'object') {
                        processPayloadObject(root[name], name);
                    }
                }
            }

            patchGlobalPlayInfo('__playinfo__');

            const publicApi = {
                version: VERSION,
                status() {
                    const now = Date.now();
                    return {
                        enabled: state.enabled,
                        mode: state.mode,
                        manualTarget: state.manualTarget,
                        autoProbe: state.autoProbe,
                        phase: state.phase,
                        preferredHost: state.lastWinner,
                        observedHost: state.observedHost,
                        benchmarkWinner: state.benchmarkWinner,
                        lastSource: state.lastSource,
                        probing: !!state.probePromise,
                        manualMatched: state.manualMatched,
                        manualMissed: state.manualMissed,
                        availableHosts: state.availableHosts.slice(),
                        nativeAkamaiAvailable:
                            state.nativeAkamaiAvailable,
                        health: Object.values(state.health).map(record => ({
                            host: record.host,
                            fresh: isFreshHealth(record, now),
                            ttlMs: healthTtlMs(record),
                            verificationDue:
                                needsHealthVerification(record, now),
                            ok: record.ok,
                            success: `${record.successes}/${record.attempts}`,
                            medianMbps: record.medianMbps,
                            medianTtfbMs: record.medianTtfbMs,
                            worstMs: record.worstMs,
                            sampledAt: new Date(
                                record.sampledAt
                            ).toISOString(),
                            verifiedAt: new Date(
                                verifiedAtOf(record, now)
                            ).toISOString()
                        }))
                    };
                },
                retest() {
                    if (
                        state.probePromise ||
                        !state.enabled ||
                        !state.currentPlan.length
                    ) {
                        return false;
                    }
                    clearCurrentHealthAndRetest();
                    return true;
                },
                setAutoProbe(next = true) {
                    return setAutoProbeEnabled(next);
                },
                enable(next = true) {
                    const saved = saveSettings({
                        enabled: !!next,
                        mode: state.mode,
                        manualTarget: state.manualTarget,
                        autoProbe: state.autoProbe
                    });
                    if (saved) {
                        root.location.reload();
                    }
                    return saved;
                },
                setMode(mode = 'auto', manualTarget) {
                    const routeId =
                        mode === 'original'
                            ? 'original'
                            : mode === 'manual'
                              ? manualTarget
                              : 'auto';
                    if (
                        !routeDefinition(routeId) ||
                        (routeId !== 'auto' &&
                            routeId !== 'original' &&
                            !availabilityForRoute(
                                routeDefinition(routeId)
                            ).available)
                    ) {
                        return false;
                    }
                    return saveRouteAndReload(routeId);
                },
                openPanel() {
                    setUiOpen(true);
                }
            };

            try {
                Object.defineProperty(root, '__BiliAutoCDN', {
                    configurable: true,
                    value: Object.freeze(publicApi)
                });
            } catch (_) {
                root.__BiliAutoCDN = publicApi;
            }

            state.benchmarkWinner = bestHealthyHost();
            mountControlUiSoon();
            startResourceObserver();
            log(
                `v${VERSION} installed`,
                state.enabled
                    ? `${state.mode}${
                          state.mode === 'manual'
                              ? `:${state.manualTarget}`
                              : ''
                      }`
                    : 'disabled'
            );
        }

        return {
            VERSION,
            CACHE_VERSION,
            HEALTH_TTL_MS,
            FAILED_HEALTH_TTL_MS,
            HEALTH_VERIFY_INTERVAL_MS,
            PROBE_BYTES,
            MAX_PROBE_HOSTS,
            UI_POSITION_KEY,
            UI_LAUNCHER_SIZE,
            UI_VIEWPORT_MARGIN,
            UI_DRAG_THRESHOLD_PX,
            SAFE_GENERIC_HOSTS,
            NATIVE_AKAMAI_ROUTE,
            DEFAULT_SETTINGS,
            normalizeSettings,
            stableUnique,
            defaultUiPosition,
            clampUiPosition,
            pointerMovedBeyondThreshold,
            parseUrl,
            hostOf,
            isAkamaiHost,
            isOfficialCdnHost,
            isMediaUrl,
            isExplicitPcdn,
            isObservableMediaRequest,
            safeSwapHost,
            collectOriginals,
            buildCandidates,
            healthTtlMs,
            healthExpiryAt,
            isFreshHealth,
            verifiedAtOf,
            needsHealthVerification,
            verificationLimitMs,
            isVerificationAcceptable,
            coldOrder,
            rankCandidates,
            rankManualCandidates,
            applyOrdering,
            walkMediaEntries,
            planFromCandidates,
            transformPlayInfo,
            median,
            aggregateProbeSamples,
            compareHealthRecords,
            uniqueProbeRoutes,
            planProbeWork,
            formatProbeAge,
            install
        };
    }
);
