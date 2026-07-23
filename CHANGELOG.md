# Changelog

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
