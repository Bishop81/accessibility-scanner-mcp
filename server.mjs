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

      // Resolve color-contrast axe leaves "incomplete" over CSS gradients (worst-case at a
      // stop -> real pass/fail). Mirrors scripts/scan.mjs. Images/translucent gradients stay incomplete.
      try {
        const ci = r.incomplete.findIndex((x) => x.id === 'color-contrast');
        if (ci !== -1) {
          const entry = r.incomplete[ci];
          const parseRgb = (s) => { const m = (s || '').match(/rgba?\(([^)]+)\)/i); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
          const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
          const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
          const contrast = (a, b) => { const hi = Math.max(lum(a), lum(b)), lo = Math.min(lum(a), lum(b)); return (hi + 0.05) / (lo + 0.05); };
          const keep = [], failed = [];
          for (const node of entry.nodes) {
            try {
              const sel = Array.isArray(node.target) ? node.target[node.target.length - 1] : node.target;
              const el = document.querySelector(sel);
              if (!el) { keep.push(node); continue; }
              const cs = getComputedStyle(el);
              const fg = parseRgb(cs.color);
              if (!fg) { keep.push(node); continue; }
              const fontPx = parseFloat(cs.fontSize) || 16, weight = parseInt(cs.fontWeight, 10) || 400;
              const required = (fontPx >= 24 || (fontPx >= 18.66 && weight >= 700)) ? 3 : 4.5;
              let bg = null;
              for (let hop = el; hop; hop = hop.parentElement) { const bi = getComputedStyle(hop).backgroundImage; if (bi && bi.indexOf('gradient(') !== -1) { bg = bi; break; } }
              if (!bg || bg.indexOf('url(') !== -1) { keep.push(node); continue; }
              const stops = (bg.match(/rgba?\([^)]+\)/gi) || []).map(parseRgb).filter(Boolean);
              if (!stops.length || stops.some((s) => s.a < 1)) { keep.push(node); continue; }
              let worst = Infinity; for (const s of stops) worst = Math.min(worst, contrast(fg, s));
              if (worst < required) { node.failureSummary = `Background is a gradient; lowest-contrast point is ${worst.toFixed(2)}:1, below the required ${required}:1.`; failed.push(node); }
            } catch (e) { keep.push(node); }
          }
          if (keep.length) { entry.nodes = keep; } else { r.incomplete.splice(ci, 1); }
          if (failed.length) {
            let v = r.violations.find((x) => x.id === 'color-contrast');
            if (!v) { v = { id: entry.id, impact: entry.impact || 'serious', help: entry.help, helpUrl: entry.helpUrl, tags: entry.tags, nodes: [] }; r.violations.push(v); }
            for (const n of failed) v.nodes.push(n);
          }
        }
      } catch (e) { /* never break the scan */ }

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
