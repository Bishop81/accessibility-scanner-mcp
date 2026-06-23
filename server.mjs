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
  { name: 'accessibility-scanner', version: '0.1.0' },
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
