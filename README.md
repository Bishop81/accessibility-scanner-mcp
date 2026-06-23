# accessibility-scanner-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent scan a web page for
**WCAG accessibility issues** and get back findings it can act on. The agent calls one tool with a
URL; it gets every violation grouped by severity, each with the **exact element selector, the
offending HTML, the specific failure, the WCAG success criterion, and a fix-guide link** — plus the
items that still need human review.

It runs the real [axe-core](https://github.com/dequelabs/axe-core) engine in your **local Chrome**
(via `playwright-core`), so nothing about the pages you scan leaves your machine. It also resolves
color contrast over CSS gradients, which most tools leave as "needs review."

Part of [accessibilityscanner.app](https://accessibilityscanner.app).

## Requirements

- Node.js 18+
- Google Chrome installed (or set the `CHROME_PATH` environment variable to a Chromium binary)

## Install

Add it to your MCP client's config. No global install needed — `npx` fetches it on first run.

**Claude Desktop** (`claude_desktop_config.json`), **Cursor**, **Claude Code**, or any MCP client:

```json
{
  "mcpServers": {
    "accessibility-scanner": {
      "command": "npx",
      "args": ["-y", "accessibility-scanner-mcp"]
    }
  }
}
```

If Chrome is not auto-detected, add an env block:

```json
{
  "mcpServers": {
    "accessibility-scanner": {
      "command": "npx",
      "args": ["-y", "accessibility-scanner-mcp"],
      "env": { "CHROME_PATH": "/usr/bin/google-chrome" }
    }
  }
}
```

## The tool

### `scan_accessibility`

| Input | |
|---|---|
| `url` (string, required) | The http(s) URL to scan. |

Returns a report grouped by severity. For each rule: the WCAG criterion, a fix-guide link, and per
element the selector, HTML, and exact failure. Example flow with an agent:

> **You:** Audit https://example.com for accessibility and fix what you can.
> **Agent:** *(calls `scan_accessibility`)* → reads the findings → edits the code → re-scans.

## Honest about limits

Automated testing covers the machine-checkable subset of WCAG (most of the issues on a typical
page, but not all of it). Items that need human judgement are returned under "Needs manual review."
It never claims a page is "compliant."

## License

MIT
