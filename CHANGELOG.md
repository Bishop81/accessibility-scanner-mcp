# Changelog

## 0.3.0

### It no longer insists on Google Chrome specifically

The launcher asked for `channel: 'chrome'` and nothing else, so a machine with Chromium or
Edge but not Google Chrome failed outright with "Install Google Chrome" — wrong, and
unhelpful, with a perfectly good browser sitting there. It now tries Chrome, then Edge, then
Chromium, then a Playwright-managed browser if one is already present, and the error lists
what it tried. `CHROME_PATH` is still honoured first and, if set, a failure there is an
error rather than a reason to go hunting.

Nothing is ever downloaded on your behalf. A scan request is not consent to pull 150MB.

### New: run with no browser at all — `SCANNER_API_URL`

Set it and the scan runs on accessibilityscanner.app rather than locally. No account, no
key: it calls the same public endpoints the website's own form uses. This makes the server
usable in CI, in containers, and on MCP hosting platforms that have no browser to give it.

Hosted scans additionally return the **nearest passing colour** for contrast failures, so an
agent gets `change the text to #767676 → 4.54:1` instead of only the ratio that failed. The
local scanner does not compute that yet.

⚠️ Hosted mode sends the scanned URL to our server. The local path sends nothing anywhere
and remains the default; this is opt-in via the environment variable only.

## 0.2.0

### Scans now load the whole page before testing

The scan previously ran as soon as the network went quiet, so it only saw what was above
the fold. Anything behind `loading="lazy"`, an `IntersectionObserver`, or a scroll-triggered
animation never rendered and was never reported.

It now scrolls the document to force that content in, waits for images, fonts and entrance
transitions, then runs axe.

Expect **more findings on the same URL** than 0.1.x returned. On one real site the count
went from 3 colour-contrast violations to 12 — identical colours throughout, the other nine
simply had not loaded. An agent acting on the old output was working from a page it had
only partly seen.

Also fixed: text was sometimes measured part-way through a fade-in, reporting a colour at
an opacity no visitor ever sees.

### Slower, deliberately

Roughly 4s → 9s per scan. The scroll pass is bounded at 12s and degrades to the previous
behaviour on a page it cannot scroll, so an infinite-scroll page cannot hang the tool call.
