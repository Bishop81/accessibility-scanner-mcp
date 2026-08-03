#!/usr/bin/env node
// MCP server: exposes an accessibility scan tool so an AI agent can audit a web page
// (axe-core, WCAG 2.2 A & AA) and get per-element selectors + fixes, ready to act on.
// Runs locally using your system Chrome via playwright-core. By accessibilityscanner.app.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright-core';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core');

// Ceiling on the settle pass below.
const SETTLE_MAX_MS = 12000;

// ─── Page settle (runs in page context) ───
// Scrolls the document so lazy-loaded content actually renders, then returns to
// the top and waits for images, fonts and entrance transitions to finish.
//
// Without this we scan whatever happened to be above the fold. That understates
// a page badly: on a Squarespace site we measured 3 contrast violations before
// this and 12 after, identical colours, the other 9 simply had not rendered.
// It also manufactures noise, since off-canvas elements come back from axe as
// "outsideViewport" with no reading at all.
//
// Kept byte-identical across scripts/scan.mjs, the CLI, the MCP server and the
// extension. Four surfaces that see different amounts of a page report different
// results for it, which is the bug this fixes. If you edit one, edit all four.
async function settlePage(options) {
  const { stepRatio = 0.75, pauseMs = 150, maxMs = 12000, settleMs = 1200 } = options || {};
  const started = Date.now();
  const doc = document.documentElement;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fullHeight = () => Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
  // maxMs bounds this whole function, not just the scroll walk, so the caller
  // can size its process timeout against one number.
  const left = () => maxMs - (Date.now() - started);
  const waitUpTo = (promise, ms) => Promise.race([promise, sleep(Math.max(0, ms))]);

  // CSS smooth scrolling makes scrollTo asynchronous, so steps would overlap and
  // observers would fire unpredictably. Forced off for the walk, restored after.
  const priorBehavior = doc.style.scrollBehavior;
  doc.style.scrollBehavior = 'auto';

  try {
    const step = Math.max(200, Math.round(window.innerHeight * stepRatio));
    // Reserve room for the tail phases so a very long page can't consume the
    // entire budget scrolling and leave nothing to render in.
    const walkBudget = maxMs - settleMs - 1500;

    // scrollHeight grows as content loads, so re-read it on every pass rather
    // than computing the stop point once up front.
    for (let y = 0, guard = 0; guard < 400; guard++) {
      if (Date.now() - started > walkBudget || y >= fullHeight()) {
        break;
      }
      window.scrollTo(0, y);
      await sleep(pauseMs);
      y += step;
    }

    // Footers usually carry the last lazy batch, and they are where contact
    // details and legal links live, so they are worth an explicit stop.
    window.scrollTo(0, fullHeight());
    await sleep(pauseMs * 2);
    window.scrollTo(0, 0);
    await sleep(pauseMs);

    // Images that only just entered the DOM still have to decode before their
    // dimensions and colours can be measured.
    const pending = Array.from(document.images).filter((img) => !img.complete);
    if (pending.length && left() > settleMs) {
      await waitUpTo(
        Promise.all(pending.map((img) => new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        }))),
        Math.min(3000, left() - settleMs),
      );
    }

    if (document.fonts && document.fonts.ready && left() > settleMs) {
      await waitUpTo(document.fonts.ready, Math.min(2000, left() - settleMs));
    }

    // Entrance transitions must finish, or text gets measured mid-fade at an
    // opacity that is not what a user ever sees.
    await sleep(settleMs);
  } finally {
    doc.style.scrollBehavior = priorBehavior;
  }
}

async function scan(url, { timeoutMs = 30000, chromePath = process.env.CHROME_PATH || '' } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('A valid http(s) URL is required.');

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: chromePath || undefined,
      channel: chromePath ? undefined : 'chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  } catch (e) {
    throw new Error(`Could not launch Chrome. Install Google Chrome or set CHROME_PATH. (${e?.message || e})`);
  }

  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; A11yScanBot/0.1; +accessibilityscanner.app)',
    });
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* chatty page */ }
    // Force lazy content to render before axe runs, then let the requests it
    // triggered finish. Bounded, and never fatal: a page we cannot scroll is
    // still worth scanning.
    try {
      await page.evaluate(settlePage, { maxMs: SETTLE_MAX_MS });
      await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch { /* hostile or navigating page — scan the state we have */ }
    await page.addScriptTag({ path: axePath });

    const out = await page.evaluate(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        resultTypes: ['violations', 'incomplete', 'passes'],
      });

      // Resolve the color-contrast results axe left "incomplete": gradients,
      // background images and translucent overlays. The resolver below is
      // byte-identical across all five scanners and guarded by
      // ScannerSurfaceParityTest — edit one, edit all five.
      try {
        await resolveColorContrast(r);
      } catch (e) { /* never let resolution break a scan */ }

      // Focus-state contrast: controls that pass at rest and fail once focused.
      // Runs AFTER axe and after the resolver, because it really focuses elements —
      // which scrolls and can fire page JS. It restores scroll and focus when done.
      try {
        await checkFocusContrast(r);
      } catch (e) { /* never let the focus pass break a scan */ }

// ─── Contrast resolution (runs in page context) ───
// Turns axe's "incomplete" color-contrast results into real passes and failures.
//
// axe gives up whenever it cannot know the backdrop from CSS alone: a gradient, a
// background image, or a translucent layer over either. That is honest of it, but
// "needs review" is the least useful thing we can tell someone, and on image-heavy
// marketing sites it is most of the contrast findings.
//
// Three sources of backdrop are resolved here:
//   gradient — fully defined by its colour stops, so the worst case is at a stop.
//   image    — rasterised to a canvas and sampled underneath the text.
//   overlay  — translucent layers composited over whatever is beneath them, which
//              is how a scrim over a hero photo actually renders.
//
// The worst case across every sample decides, matching how the gradient path already
// worked: a heading that is legible over the light end of a photo and invisible over
// the dark end is a real failure, and reporting the average would hide it.
//
// WHERE THIS STILL BAILS, AND WHY THAT IS DELIBERATE
// A sample can be wrong in two directions, and only one of them is acceptable. Saying
// "needs review" when we could have decided is a missed opportunity; saying "passes"
// when the text is unreadable is the fake-compliance badge this product exists to
// argue against. So anything not confidently derivable stays incomplete: cross-origin
// images that taint the canvas, background-attachment: fixed, exotic background-size
// or repeat keywords, images with no intrinsic size, and any decode failure.
async function resolveColorContrast(results) {
  const ci = results.incomplete.findIndex((r) => r.id === 'color-contrast');
  if (ci === -1) return;
  const entry = results.incomplete[ci];

  const DEADLINE = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 6000;   // must leave room inside process_timeout_margin
  // A backstop against a pathological page, not the real limiter — the time budget is.
  // 40 was too low: our own homepage has 54 flagged nodes, so the cap silently left 14
  // unresolved that the resolver could have decided. Gradient-only nodes need no async
  // work at all, and rasters are cached per URL, so the common case is cheap.
  const MAX_NODES = 500;
  const GRID = 7;                // 49 samples per node is plenty to find a worst case
  const overBudget = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) > DEADLINE;

  // Split on commas that are NOT inside parentheses. A naive split tears
  // "radial-gradient(120% 80% at 50% -10%, color(srgb ...), ...)" apart at its first
  // internal comma, which silently produced zero colour stops and made every gradient
  // on a modern site fall back to "needs review".
  const splitTop = (s) => {
    const out = [];
    let depth = 0, buf = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim() !== '') out.push(buf);
    return out.map((x) => x.trim());
  };

  // Let the browser resolve colour tokens instead of pattern-matching them.
  // Regexing rgb()/rgba() misses every modern syntax — color(srgb ...), oklch(), lab(),
  // hwb(), color-mix() — and Tailwind v4 emits those by default, so the previous parser
  // was blind to the gradients on most current sites. Painting one pixel handles any
  // syntax the engine itself understands, now and later.
  const swatch = document.createElement('canvas');
  swatch.width = swatch.height = 1;
  const swatchCtx = swatch.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  const parseRgb = (s) => {
    const key = (s || '').trim();
    if (!key || key === 'none') return null;
    if (colorCache.has(key)) return colorCache.get(key);

    let value = null;
    // Fast path: plain rgb()/rgba() is the overwhelmingly common case.
    const m = key.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter((x) => x !== '').map((x) => parseFloat(x));
      if (p.length >= 3 && p.every((x) => isFinite(x))) {
        value = { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
    }
    if (!value) {
      try {
        // fillStyle silently ignores an invalid value, so prove it took by using a
        // sentinel that the token cannot itself be.
        swatchCtx.fillStyle = '#000000';
        swatchCtx.fillStyle = key;
        const accepted = swatchCtx.fillStyle;
        swatchCtx.fillStyle = '#ffffff';
        swatchCtx.fillStyle = key;
        if (accepted === swatchCtx.fillStyle) {
          swatchCtx.globalCompositeOperation = 'copy';   // no blend with what was there
          swatchCtx.fillRect(0, 0, 1, 1);
          const d = swatchCtx.getImageData(0, 0, 1, 1).data;
          value = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        }
      } catch (e) {
        value = null;
      }
    }
    colorCache.set(key, value);
    return value;
  };
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const contrast = (a, b) => {
    const hi = Math.max(lum(a), lum(b)), lo = Math.min(lum(a), lum(b));
    return (hi + 0.05) / (lo + 0.05);
  };
  // Source-over: place `top` (possibly translucent) on an opaque `base`.
  const over = (top, base) => ({
    r: top.a * top.r + (1 - top.a) * base.r,
    g: top.a * top.g + (1 - top.a) * base.g,
    b: top.a * top.b + (1 - top.a) * base.b,
    a: 1,
  });

  // What the browser actually paints where nothing else is: html, then body, else white.
  const canvasBase = (() => {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const c = parseRgb(getComputedStyle(el).backgroundColor);
      if (c && c.a === 1) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  })();

  const num = (token, basis, fontPx) => {
    const t = (token || '').trim();
    if (t.endsWith('%')) return (parseFloat(t) / 100) * basis;
    if (t.endsWith('px')) return parseFloat(t);
    if (t.endsWith('em')) return parseFloat(t) * fontPx;
    if (t.endsWith('rem')) return parseFloat(t) * 16;
    return NaN;
  };

  // Decoded pixels per URL, shared across nodes: hero images repeat constantly and
  // decoding one twice is the difference between a fast scan and a timeout.
  const rasterCache = new Map();

  async function raster(url) {
    if (rasterCache.has(url)) return rasterCache.get(url);
    let value = null;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';   // same-origin unaffected; CORS-enabled remotes work
      img.src = url;
      await (img.decode ? img.decode() : new Promise((res, rej) => {
        img.onload = res; img.onerror = rej;
        setTimeout(rej, 4000);
      }));
      const w = img.naturalWidth, h = img.naturalHeight;
      // An SVG with no intrinsic size rasterises at an arbitrary scale; refuse to guess.
      if (!w || !h) throw new Error('no intrinsic size');
      const cap = 600;                 // downscale: we need colour, not detail
      const sw = Math.max(1, Math.min(w, cap)), sh = Math.max(1, Math.min(h, cap));
      const cv = document.createElement('canvas');
      cv.width = sw; cv.height = sh;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, sw, sh);
      // Throws SecurityError on a tainted canvas — a cross-origin image without CORS.
      const data = ctx.getImageData(0, 0, sw, sh);
      value = { data, sw, sh, nw: w, nh: h };
    } catch (e) {
      value = null;                    // unknown, not "fine"
    }
    rasterCache.set(url, value);
    return value;
  }

  // The background layers between the text and an opaque backdrop, nearest first.
  function layersFor(el) {
    const out = [];
    for (let hop = el; hop; hop = hop.parentElement) {
      const cs = getComputedStyle(hop);
      const image = cs.backgroundImage || 'none';

      if (image !== 'none') {
        // Only the topmost layer is interpreted; stacked layers composite in ways
        // that are not worth guessing at.
        const first = splitTop(image)[0];
        if (first.indexOf('gradient(') !== -1) {
          // Inside the parens: a direction/shape token, then colour stops each with an
          // optional position. Strip positions, keep whatever resolves to a colour.
          const open = first.indexOf('(');
          const inner = first.slice(open + 1, first.lastIndexOf(')'));
          const stops = splitTop(inner)
            .map((part) => part.replace(/\s+(-?[\d.]+(%|px|em|rem|deg|turn|rad|grad)|calc\(.*\))+$/i, '').trim())
            .map(parseRgb)
            .filter(Boolean);
          if (!stops.length) return null;
          out.push({ kind: 'gradient', stops });
        } else {
          // background-attachment: fixed anchors the image to the viewport, so an
          // element's own box no longer tells us which part of it sits behind the text.
          // This restriction is specific to images: a gradient's stops are the same set
          // wherever it is anchored, so the worst case is still knowable — bailing on
          // `fixed` wholesale left every gradient on a fixed-background page unresolved.
          if (splitTop(cs.backgroundAttachment || 'scroll')[0] === 'fixed') return null;
          const m = first.match(/url\((['"]?)(.*?)\1\)/i);
          if (!m || !m[2]) return null;
          let abs;
          try { abs = new URL(m[2], document.baseURI).href; } catch (e) { return null; }
          out.push({ kind: 'image', url: abs, el: hop, cs });
        }
      }

      const bc = parseRgb(cs.backgroundColor);
      if (bc && bc.a > 0) {
        out.push({ kind: 'color', color: bc });
        if (bc.a === 1) return out;    // fully opaque: nothing below it shows through
      }
      // A gradient or image with no transparency also terminates the stack, but we
      // cannot know that without sampling, so the sampler decides and we keep walking.
      if (out.length && out[out.length - 1].kind !== 'color') {
        const last = out[out.length - 1];
        if (last.kind === 'gradient' && last.stops.every((s) => s.a === 1)) return out;
        if (last.kind === 'image') return out;
      }
    }
    return out;
  }

  // Candidate backdrop colours under `rect`, or null when they cannot be known.
  async function backdropsUnder(layers, rect, fontPx) {
    let base = [canvasBase];

    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];

      if (layer.kind === 'color') {
        base = base.map((b) => (layer.color.a === 1 ? layer.color : over(layer.color, b)));
        continue;
      }

      if (layer.kind === 'gradient') {
        const next = [];
        for (const b of base) {
          for (const s of layer.stops) next.push(s.a === 1 ? s : over(s, b));
        }
        base = next;
        continue;
      }

      // image: sample the pixels that actually sit beneath the text
      const r = await raster(layer.url);
      if (!r) return null;

      const box = layer.el.getBoundingClientRect();
      if (!box.width || !box.height) return null;

      const cs = layer.cs;
      const size = splitTop(cs.backgroundSize || 'auto')[0];
      const repeat = splitTop(cs.backgroundRepeat || 'repeat')[0];
      if (/space|round/.test(repeat)) return null;

      const ratio = r.nw / r.nh;
      let dw, dh;
      if (size === 'cover' || size === 'contain') {
        const boxRatio = box.width / box.height;
        const wide = size === 'cover' ? boxRatio < ratio : boxRatio > ratio;
        if (wide) { dh = box.height; dw = dh * ratio; } else { dw = box.width; dh = dw / ratio; }
      } else if (size === 'auto') {
        dw = r.nw; dh = r.nh;
      } else {
        const parts = size.split(/\s+/);
        const pw = parts[0], ph = parts.length > 1 ? parts[1] : 'auto';
        dw = pw === 'auto' ? NaN : num(pw, box.width, fontPx);
        dh = ph === 'auto' ? NaN : num(ph, box.height, fontPx);
        if (!isFinite(dw) && !isFinite(dh)) return null;
        if (!isFinite(dw)) dw = dh * ratio;
        if (!isFinite(dh)) dh = dw / ratio;
      }
      if (!isFinite(dw) || !isFinite(dh) || dw <= 0 || dh <= 0) return null;

      const pos = splitTop(cs.backgroundPosition || '0% 0%')[0].split(/\s+/);
      const px = num(pos[0] === 'left' ? '0%' : pos[0] === 'right' ? '100%' : pos[0] === 'center' ? '50%' : pos[0], box.width - dw, fontPx);
      const rawY = pos.length > 1 ? pos[1] : '50%';
      const py = num(rawY === 'top' ? '0%' : rawY === 'bottom' ? '100%' : rawY === 'center' ? '50%' : rawY, box.height - dh, fontPx);
      if (!isFinite(px) || !isFinite(py)) return null;

      const repeatX = repeat === 'repeat' || repeat === 'repeat-x';
      const repeatY = repeat === 'repeat' || repeat === 'repeat-y';

      const samples = [];
      for (let iy = 0; iy < GRID; iy++) {
        for (let ix = 0; ix < GRID; ix++) {
          // Inset slightly: the glyph edges are antialiased against the backdrop.
          const fx = (ix + 0.5) / GRID, fy = (iy + 0.5) / GRID;
          const sx = rect.left + fx * rect.width - box.left - px;
          const sy = rect.top + fy * rect.height - box.top - py;

          let u = sx, v = sy;
          if (repeatX) u = ((sx % dw) + dw) % dw;
          if (repeatY) v = ((sy % dh) + dh) % dh;
          if (u < 0 || u >= dw || v < 0 || v >= dh) continue;   // outside the painted image

          const ipx = Math.min(r.sw - 1, Math.max(0, Math.floor((u / dw) * r.sw)));
          const ipy = Math.min(r.sh - 1, Math.max(0, Math.floor((v / dh) * r.sh)));
          const o = (ipy * r.sw + ipx) * 4;
          const a = r.data.data[o + 3] / 255;
          const c = { r: r.data.data[o], g: r.data.data[o + 1], b: r.data.data[o + 2], a };
          for (const b of base) samples.push(a === 1 ? c : over(c, b));
        }
      }
      // Nothing landed on the image (e.g. no-repeat and the text sits outside it):
      // whatever is beneath still applies, so carry on rather than bailing.
      if (!samples.length) continue;
      base = samples;
    }

    return base.length ? base : null;
  }

  const keep = [];
  const failed = [];
  let processed = 0;

  for (const node of entry.nodes) {
    try {
      if (processed >= MAX_NODES || overBudget()) { keep.push(node); continue; }
      processed++;

      const sel = Array.isArray(node.target) ? node.target[node.target.length - 1] : node.target;
      const el = document.querySelector(sel);
      if (!el) { keep.push(node); continue; }

      const cs = getComputedStyle(el);
      const fg = parseRgb(cs.color);
      if (!fg) { keep.push(node); continue; }

      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) { keep.push(node); continue; }

      const fontPx = parseFloat(cs.fontSize) || 16;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const required = (fontPx >= 24 || (fontPx >= 18.66 && weight >= 700)) ? 3 : 4.5;

      const layers = layersFor(el);
      if (!layers || !layers.length) { keep.push(node); continue; }
      if (!layers.some((l) => l.kind === 'image' || l.kind === 'gradient' || l.color.a < 1)) {
        keep.push(node); continue;     // plain opaque colour: axe had another reason
      }

      const backdrops = await backdropsUnder(layers, rect, fontPx);
      if (!backdrops) { keep.push(node); continue; }

      let worst = Infinity;
      for (const b of backdrops) worst = Math.min(worst, contrast(fg, b));
      if (!isFinite(worst)) { keep.push(node); continue; }

      if (worst < required) {
        const what = layers.some((l) => l.kind === 'image')
          ? 'a background image'
          : layers.some((l) => l.kind === 'gradient') ? 'a gradient' : 'a translucent layer';
        node.failureSummary =
          'Element sits on ' + what + '. Measured at its lowest-contrast point the ratio is '
          + worst.toFixed(2) + ':1, below the required ' + required + ':1.';
        failed.push(node);
      }
      // worst >= required → legible everywhere it is painted → resolved, drop it
    } catch (e) {
      keep.push(node);                 // never turn an error into a pass
    }
  }

  if (keep.length) { entry.nodes = keep; } else { results.incomplete.splice(ci, 1); }

  if (failed.length) {
    let v = results.violations.find((r) => r.id === 'color-contrast');
    if (!v) {
      v = {
        id: entry.id, impact: entry.impact || 'serious', description: entry.description,
        help: entry.help, helpUrl: entry.helpUrl, tags: entry.tags, nodes: [],
      };
      results.violations.push(v);
    }
    for (const n of failed) v.nodes.push(n);
  }
}

// ─── Focus-state contrast (runs in page context) ───
// Finds controls whose text contrast PASSES at rest and FAILS once focused.
//
// axe-core cannot report this: its only contrast rules are color-contrast (AA) and
// color-contrast-enhanced (AAA), and both measure the default rendered state. There is
// no focus-contrast rule in axe at all. So a button that reads white-on-teal normally
// and white-on-pale-grey when tabbed to passes every automated check while being
// unusable for the keyboard users who most depend on seeing the focused state.
//
// HOW THE FOCUS STATE IS MEASURED — AND WHY READING STYLESHEETS DOES NOT WORK
// The first version of this read the CSS: find rules whose selector carries :focus,
// strip the pseudo-class, test whether the element matches, apply those declarations.
// It was fast, side-effect free, and WRONG. Validated against ground truth it reported
// failures on 6 of 14 real shops where the rendered style does not change on focus at
// all. Two reasons: it approximated the cascade by document order and so lost every
// specificity contest, and it descended into @media groups without checking the query,
// so a `@media print { a:focus { color: #999 } }` counted as if it applied on screen.
//
// A false "your site fails" is the fake-compliance badge inverted, so the browser now
// decides. Each candidate is really focused and the computed style is read back. CSS is
// still parsed, but only to pick candidates worth focusing — over-inclusion there is
// harmless because the measurement no longer trusts it.
//
// focus({ focusVisible: true }) does produce :focus-visible in Chrome, including on
// anchors, which was the original objection to this approach and turned out to be false.
//
// KNOWN LIMITS, deliberately not guessed at:
//   - The focus pass runs AFTER axe, and restores scroll position and the previously
//     focused element, but focusing can still fire page JavaScript.
//   - Cross-origin stylesheets cannot be read, so a candidate whose only focus rule
//     lives in a CDN sheet is never tried (14-21% of sheets on real sites).
//   - A focus state over a background IMAGE is not resolved, only solid colours and
//     gradients. Reporting nothing is the right failure there.
//   - Only elements reachable by TAB count. tabindex="-1" is programmatically focusable
//     only, so a keyboard user cannot land on it and there is no barrier.
async function checkFocusContrast(results) {
  const MAX_ELEMENTS = 400;
  const DEADLINE = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 4000;
  const overBudget = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) > DEADLINE;

  const swatch = document.createElement('canvas');
  swatch.width = swatch.height = 1;
  const sctx = swatch.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();

  // Same browser-backed parse as the contrast resolver: regexing rgb() is blind to
  // color(srgb ...), oklch() and friends, which current CSS emits by default.
  const parseRgb = (s) => {
    const key = (s || '').trim();
    if (!key || key === 'none' || key === 'transparent') return null;
    if (colorCache.has(key)) return colorCache.get(key);
    let value = null;
    const m = key.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter((x) => x !== '').map((x) => parseFloat(x));
      if (p.length >= 3 && p.every((x) => isFinite(x))) {
        value = { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
    }
    if (!value) {
      try {
        sctx.fillStyle = '#000000';
        sctx.fillStyle = key;
        const accepted = sctx.fillStyle;
        sctx.fillStyle = '#ffffff';
        sctx.fillStyle = key;
        if (accepted === sctx.fillStyle) {
          sctx.globalCompositeOperation = 'copy';
          sctx.fillRect(0, 0, 1, 1);
          const d = sctx.getImageData(0, 0, 1, 1).data;
          value = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        }
      } catch (e) { value = null; }
    }
    colorCache.set(key, value);
    return value;
  };

  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const contrast = (a, b) => {
    const hi = Math.max(lum(a), lum(b)), lo = Math.min(lum(a), lum(b));
    return (hi + 0.05) / (lo + 0.05);
  };
  const over = (top, base) => ({
    r: top.a * top.r + (1 - top.a) * base.r,
    g: top.a * top.g + (1 - top.a) * base.g,
    b: top.a * top.b + (1 - top.a) * base.b,
    a: 1,
  });
  const splitTop = (s) => {
    const out = []; let depth = 0, buf = '';
    for (const ch of s) {
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim() !== '') out.push(buf);
    return out.map((x) => x.trim());
  };
  // A background-image value only counts if it actually names one. The `background`
  // SHORTHAND expands to background-image: "initial" in CSSOM, and an earlier version
  // treated that string as an image, failed to parse it as a gradient, and silently
  // skipped every control whose focus rule used the shorthand — which is most of them.
  const paintsImage = (v) => !!v && /(^|\s)(linear-|radial-|conic-|repeating-)?gradient\(|url\(/i.test(v);

  const gradientStops = (image) => {
    const first = splitTop(image)[0] || '';
    if (first.indexOf('gradient(') === -1) return null;
    const inner = first.slice(first.indexOf('(') + 1, first.lastIndexOf(')'));
    const stops = splitTop(inner)
      .map((part) => part.replace(/\s+(-?[\d.]+(%|px|em|rem|deg|turn|rad|grad)|calc\(.*\))+$/i, '').trim())
      .map(parseRgb)
      .filter(Boolean);
    return stops.length ? stops : null;
  };

  const canvasBase = (() => {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const c = parseRgb(getComputedStyle(el).backgroundColor);
      if (c && c.a === 1) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  })();

  // Candidate backdrops behind an element, given its own background declarations.
  // Returns null when the answer cannot be established (an image, most often).
  const backdropsFor = (el, ownColor, ownImage) => {
    let base = null;
    for (let hop = el.parentElement; hop; hop = hop.parentElement) {
      const cs = getComputedStyle(hop);
      if (paintsImage(cs.backgroundImage)) {
        const stops = gradientStops(cs.backgroundImage);
        if (!stops) return null;                       // image behind: not resolvable here
        base = stops.filter((s) => s.a === 1);
        if (base.length) break;
        return null;
      }
      const bc = parseRgb(cs.backgroundColor);
      if (bc && bc.a === 1) { base = [bc]; break; }
    }
    if (!base || !base.length) base = [canvasBase];

    if (paintsImage(ownImage)) {
      const stops = gradientStops(ownImage);
      if (!stops) return null;
      const out = [];
      for (const b of base) for (const s of stops) out.push(s.a === 1 ? s : over(s, b));
      return out;
    }
    if (ownColor && ownColor.a > 0) {
      return base.map((b) => (ownColor.a === 1 ? ownColor : over(ownColor, b)));
    }
    return base;
  };

  const worstAgainst = (fg, backdrops) => {
    let worst = Infinity;
    for (const b of backdrops) worst = Math.min(worst, contrast(fg, b));
    return worst;
  };

  // Every :focus / :focus-visible declaration that applies to el, in document order.
  const focusRules = (() => {
    const collected = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }   // cross-origin sheet
      if (!rules) continue;
      const walk = (list) => {
        for (const rule of Array.from(list)) {
          if (rule.cssRules && !rule.selectorText) { walk(rule.cssRules); continue; }  // @media etc
          if (!rule.selectorText) continue;
          if (!/:focus(-visible|-within)?\b/.test(rule.selectorText)) continue;
          for (const sel of rule.selectorText.split(',')) {
            const bare = sel.replace(/::?focus(-visible|-within)?\b/g, '').trim();
            if (!bare) continue;
            collected.push({ bare, style: rule.style });
          }
        }
      };
      walk(rules);
    }
    return collected;
  })();

  // Is this element worth the cost of focusing? Only a candidate filter — deliberately
  // over-inclusive, since the real measurement below no longer trusts this answer.
  const mightRestyleOnFocus = (el) => {
    for (const { bare, style } of focusRules) {
      if (!style.getPropertyValue('color')
        && !style.getPropertyValue('background-color')
        && !style.getPropertyValue('background-image')) continue;
      try { if (el.matches(bare)) return true; } catch (e) { continue; }
    }
    return false;
  };

  const focusable = Array.from(document.querySelectorAll(
    'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
  ));

  // A selector that resolves to THIS element and nothing else. "button.btn" is useless
  // in a report — a page has forty of them, so the reader cannot find the one we mean and
  // cannot check our claim. Walks up adding :nth-of-type until the path is unambiguous,
  // which is what axe does for the same reason.
  const uniqueSelector = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName)
        : [node];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (e) { /* keep going */ }
    }
    const joined = parts.join(' > ');
    return joined || el.tagName.toLowerCase();
  };

  const failed = [];
  let focusedCount = 0;

  // Focusing scrolls and moves the caret, so remember what to put back.
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const previouslyFocused = document.activeElement;

  const snapshot = (el) => {
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: cs.backgroundColor, img: cs.backgroundImage,
             fontPx: parseFloat(cs.fontSize) || 16, weight: parseInt(cs.fontWeight, 10) || 400 };
  };

  try {
    for (const el of focusable) {
      try {
        if (focusedCount >= MAX_ELEMENTS || overBudget()) break;

        if (el.disabled) continue;
        const ti = el.getAttribute('tabindex');
        if (ti !== null && parseInt(ti, 10) < 0) continue;
        if (el.closest('[aria-hidden="true"]')) continue;
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
        if (!mightRestyleOnFocus(el)) continue;

        const rest = snapshot(el);
        const restFg = parseRgb(rest.color);
        if (!restFg) continue;

        focusedCount++;
        try { el.focus({ focusVisible: true }); } catch (e) { try { el.focus(); } catch (e2) { continue; } }
        if (document.activeElement !== el) continue;      // refused focus: nothing to measure
        const foc = snapshot(el);
        try { el.blur(); } catch (e) { /* ignore */ }

        // The browser says nothing changed, so there is no focus-state failure. This is
        // the check the stylesheet version lacked, and it is what makes the result true.
        if (foc.color === rest.color && foc.bg === rest.bg && foc.img === rest.img) continue;

        const required = (rest.fontPx >= 24 || (rest.fontPx >= 18.66 && rest.weight >= 700)) ? 3 : 4.5;

        const restBackdrops = backdropsFor(el, parseRgb(rest.bg), rest.img);
        if (!restBackdrops) continue;
        const restRatio = worstAgainst(restFg, restBackdrops);
        // Already failing at rest? axe's own color-contrast rule reports that; saying it
        // twice is noise, and the interesting claim is specifically the state CHANGE.
        if (!isFinite(restRatio) || restRatio < required) continue;

        const focusFg = parseRgb(foc.color);
        if (!focusFg) continue;
        const focusBackdrops = backdropsFor(el, parseRgb(foc.bg), foc.img);
        if (!focusBackdrops) continue;
        const focusRatio = worstAgainst(focusFg, focusBackdrops);
        if (!isFinite(focusRatio) || focusRatio >= required) continue;

        const selector = uniqueSelector(el);

        failed.push({
          target: [selector],
          html: (el.outerHTML || '').slice(0, 4096),
          impact: 'serious',
          failureSummary:
            'Element passes contrast at rest (' + restRatio.toFixed(2) + ':1) but drops to '
            + focusRatio.toFixed(2) + ':1 when focused, below the required ' + required
            + ':1. Keyboard users see only the focused state.',
        });
      } catch (e) { /* one bad element must never cost the rest */ }
    }
  } finally {
    try { if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus(); } catch (e) { /* ignore */ }
    try { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); } catch (e) { /* ignore */ }
    window.scrollTo(scrollX, scrollY);
  }

  if (failed.length) {
    results.violations.push({
      id: 'color-contrast-focus',
      impact: 'serious',
      description: 'Ensure text keeps sufficient contrast when its control is focused',
      help: 'Focused controls must still meet the contrast minimum',
      // 1.4.3 is the criterion: this is still contrast of text, measured in the state a
      // keyboard user actually sees.
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
      tags: ['cat.color', 'wcag2aa', 'wcag143'],
      nodeCount: failed.length,
      nodes: failed,
    });
  }
}


      const wcag = (tags) => (tags || []).map((t) => { const m = t.match(/^wcag(\d)(\d)(\d{1,2})$/); return m ? `${m[1]}.${m[2]}.${m[3]}` : null; }).filter(Boolean);
      const slim = (items) => items.map((v) => ({
        rule: v.id, impact: v.impact || 'minor', help: v.help, helpUrl: v.helpUrl,
        wcag: wcag(v.tags), elementCount: v.nodes.length,
        elements: v.nodes.slice(0, 25).map((n) => ({
          selector: Array.isArray(n.target) ? n.target.join(' ') : String(n.target),
          html: (n.html || '').slice(0, 300),
          issue: (n.failureSummary || '').replace(/^Fix (any|all) of the following:\s*/i, '').trim(),
        })),
      }));

      return { violations: slim(r.violations), needsReview: slim(r.incomplete), passes: r.passes.length, engine: r.testEngine && r.testEngine.version };
    });

    return { url, httpStatus: res ? res.status() : null, ...out };
  } finally {
    await browser.close();
  }
}

function formatReport(s) {
  const order = ['critical', 'serious', 'moderate', 'minor'];
  const total = s.violations.reduce((a, v) => a + (order.includes(v.impact) ? 1 : 0), 0) || s.violations.length;
  const lines = [];
  lines.push(`# Accessibility scan: ${s.url}`);
  lines.push(`HTTP ${s.httpStatus ?? 'n/a'} · axe-core ${s.engine || ''} · WCAG 2.2 A & AA`);
  lines.push('');
  lines.push(`${s.violations.length} violation rule(s), ${s.needsReview.length} item(s) needing manual review, ${s.passes} checks passed.`);
  lines.push('> Automated testing covers the machine-checkable subset of WCAG. The needs-review items require human judgement.');

  const byImpact = {};
  for (const v of s.violations) (byImpact[v.impact] || (byImpact[v.impact] = [])).push(v);
  const section = (title, items) => {
    if (!items.length) return;
    lines.push('', `## ${title}`);
    for (const v of items) {
      lines.push('', `### ${v.rule} — ${v.help} (${v.elementCount} element${v.elementCount === 1 ? '' : 's'})`);
      if (v.wcag.length) lines.push(`WCAG: ${v.wcag.join(', ')}`);
      if (v.helpUrl) lines.push(`Fix guide: ${v.helpUrl}`);
      for (const el of v.elements) {
        lines.push(`- selector: \`${el.selector}\``);
        if (el.html) lines.push(`  html: \`${el.html.replace(/`/g, "'")}\``);
        if (el.issue) lines.push(`  issue: ${el.issue.replace(/\n+/g, ' ')}`);
      }
      if (v.elementCount > v.elements.length) lines.push(`  (+${v.elementCount - v.elements.length} more element(s))`);
    }
  };
  for (const imp of order) section(imp[0].toUpperCase() + imp.slice(1), byImpact[imp] || []);
  // any non-standard impacts
  section('Other', s.violations.filter((v) => !order.includes(v.impact)));
  section('Needs manual review', s.needsReview);
  lines.push('', '---', 'Generated by accessibility-scanner-mcp · https://accessibilityscanner.app');
  return lines.join('\n');
}

const server = new Server(
  { name: 'accessibility-scanner', version: '0.1.2' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan_accessibility',
      description:
        'Scan a web page for WCAG 2.2 (A & AA) accessibility issues using axe-core in a real browser. ' +
        'Returns violations grouped by severity, each with the exact element selector, the offending HTML, the ' +
        'specific failure, the WCAG success criterion, and a fix-guide link — ready to act on. Also lists items ' +
        'that need manual human review. Use this to audit a page and then fix the issues. Requires Google Chrome ' +
        'installed locally (or set the CHROME_PATH environment variable).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL of the page to scan.' },
        },
        required: ['url'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'scan_accessibility') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const url = request.params.arguments?.url;
  try {
    const result = await scan(String(url));
    return { content: [{ type: 'text', text: formatReport(result) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Scan failed: ${e?.message || e}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs (stdout is the MCP transport).
console.error('accessibility-scanner-mcp running on stdio');
