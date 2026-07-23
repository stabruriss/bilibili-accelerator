# Bilibili Accelerator

[简体中文](README.md) | [English](README.en.md)

[![CI](https://github.com/stabruriss/bilibili-accelerator/actions/workflows/ci.yml/badge.svg)](https://github.com/stabruriss/bilibili-accelerator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-00aeec.svg)](LICENSE)
[![Install userscript](https://img.shields.io/badge/Install-userscript-00aeec.svg)](https://raw.githubusercontent.com/stabruriss/bilibili-accelerator/main/bilibili-accelerator.user.js)

This is a userscript for the frustrating case where your connection is fast
enough, but Bilibili video playback still stutters or buffers.

- Includes four commonly useful CDN routes and accelerates playback by
  switching the video CDN.
- Benchmarks routes automatically and can select the best-performing CDN.
- Lets you choose a CDN manually or turn automatic testing on and off.
- Select “Bilibili Original” to disable route switching and restore Bilibili's
  untouched play URLs.

This project is not affiliated with or officially endorsed by Bilibili.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Click
   **[Install Bilibili Accelerator](https://raw.githubusercontent.com/stabruriss/bilibili-accelerator/main/bilibili-accelerator.user.js)**.
3. Disable any other userscript that rewrites Bilibili CDN addresses.
4. Open or refresh any Bilibili video page.

The script includes an `@updateURL`, so Tampermonkey can check the repository's
`main` branch for updates.

## What problem does it solve?

On some overseas networks, `curl` or ordinary download tests may be fast while
the browser player still suffers intermittent DASH-fragment timeouts and
buffering. Pinning one CDN is not always reliable because:

- Bilibili's API returns different native primary and fallback routes for
  different videos.
- Akamai URLs depend on native `hdnts` signatures and cannot be created by
  replacing only the hostname.
- Edge nodes and real network paths behind the same hostname can change over
  time.
- Peak Mbps alone does not capture timeouts, time to first byte, or the slowest
  request.

Bilibili Accelerator performs small Range tests against real URLs that the
current video can access. It then uses the cached health results when arranging
the next play URL, without blocking video startup.

## Safety boundaries

- Preserves the complete native primary and fallback URLs returned by
  Bilibili's API.
- Uses Akamai only when the API supplies the original URL with its signature.
- Generates ordinary UPOS hosts only from a code-level allowlist; it never
  accepts arbitrary hosts injected by the page or user.
- Demotes PCDN addresses behind official CDN routes.
- Restores Bilibili's original routes when every benchmark fails.
- Never stores complete media URLs, signatures, cookies, or tokens.
- Sends no analytics, telemetry, or user data.

## Control panel

Video pages display a draggable, translucent lightning dot:

- Blue: the script is routing playback.
- Yellow: waiting for a safe benchmark window.
- Red: a benchmark or settings save failed.
- Gray: using “Bilibili Original.”

Click the dot to open the `Bilibili Accelerator` panel. Available modes are:

- **Automatic**: reorder routes using valid benchmark results.
- **Bilibili Original**: leave play URLs completely untouched; this is also the
  panel's master off mode.
- **Cosov / Aliov / Hong Kong EQ**: put the selected route first while
  retaining native routes as fallbacks.
- **Native Akamai**: available only when the current video's API actually
  returns a signed Akamai URL.

After choosing a mode, click “Refresh and apply.” Every concrete CDN route
shows Mbps, TTFB, success state, and the age of its last full benchmark.

The “Automatic testing” switch at the bottom controls background benchmarks
only; it does not change the selected route:

- On: when cached health needs verification or expires, test in the background
  after a new play URL appears.
- Off: do not start background tests; “Retest” can still force a full manual
  benchmark.

## Automatic selection

A full benchmark reads two 256 KiB Ranges from each candidate route,
sequentially:

1. A route is healthy only if both Ranges complete.
2. Routes are compared by success ratio first, then by the slower of the two
   completion times.
3. If two healthy routes differ by no more than 15%, preserve Bilibili's
   original API order to avoid route flapping.
4. Mbps is an observational throughput metric; it does not select the winner
   on its own.

Cache and verification behavior:

- Successful full benchmarks are cached for 4 hours.
- Failed results are cached for 15 minutes; only that failed route is retested
  after expiry.
- The actual preferred route receives at most one lightweight, single-Range
  verification every 15 minutes.
- A failed or significantly slower lightweight verification promotes the work
  to a full benchmark.
- Testing begins after a 1.2-second delay and waits until the video is paused
  or has at least 15 seconds of buffered playback.

## Permissions and privacy

The userscript uses `@grant none` and matches only:

- `https://www.bilibili.com/*`
- `https://m.bilibili.com/*`

It sends small Range requests to Bilibili's native CDNs and the built-in
official UPOS candidates. In `localStorage`, it stores only the selected mode,
the automatic-testing preference, launcher coordinates, and per-host summaries
of attempts, speeds, TTFB, worst completion time, and timestamps.

Do not paste complete media URLs into an issue. They may contain short-lived
signatures or other sensitive parameters. Keep only the hostname and remove
the query string.

## Compatibility

The primary development and test environment is a desktop Chromium browser
with Tampermonkey. Other browsers or userscript managers may work, but they are
not currently official compatibility targets.

This script handles CDN addresses only. It does not change player settings such
as `nc_disable / rp_disable / p2p_disable`.

## Local development

Node.js 18 or newer is required. There are no runtime dependencies to install:

```bash
npm run check
npm test
```

Main files:

- `bilibili-accelerator.user.js`: the directly installable userscript.
- `bilibili-accelerator.test.js`: tests for URL handling, safety boundaries,
  caching, and browser interception.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing. Report security
issues privately by following [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 stabruriss
