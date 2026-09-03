# site-to-md 🤖

Make any website AI-agent-readable. Generates `/llms.txt` + clean markdown for every page.

> `robots.txt` told search engines what to crawl. `llms.txt` tells AI agents what to read. This tool generates both automatically.

## Quick Start

```bash
npx site-to-md https://mysite.com
```

That's it. Zero config. You'll get:

```
mysite.com-md/
├── llms.txt           # Index file per llmstxt.org spec
├── llms-ctx.txt       # All content inline (for single-prompt ingestion)
├── index.html.md      # Homepage as markdown
├── docs/
│   ├── getting-started.html.md
│   └── api-reference.html.md
└── blog/
    ├── hello-world.html.md
    └── release-notes.html.md
```

The doubled extension in `.html.md` is intentional — it's the [llmstxt.org](https://llmstxt.org) convention. A page's markdown mirror lives at that page's own URL with `.md` appended, so an agent that knows a URL can find its clean version without an index lookup.

## What It Does

1. **Crawls your site** — follows links or uses `sitemap.xml` if available
2. **Extracts content** — strips nav, footer, ads, scripts using [Mozilla Readability](https://github.com/mozilla/readability) (same as Firefox Reader View)
3. **Converts to markdown** — via [Turndown](https://github.com/mixmark-io/turndown)
4. **Checks its own work** — warns when a page loses content in extraction
5. **Generates `/llms.txt`** — per the [llmstxt.org](https://llmstxt.org) spec
6. **Generates per-page `.html.md` files** — per the spec convention
7. **Generates `/llms-ctx.txt`** — all content inline for single-prompt ingestion

## Install

```bash
# Use directly with npx (no install needed)
npx site-to-md https://mysite.com

# Or install globally
npm install -g site-to-md

# Or as a project dependency
npm install site-to-md
```

The installed command is `agent-ready`; `npx site-to-md` works too.

## CLI Usage

```bash
# Crawl a live website
site-to-md https://docs.mysite.com

# Process local build output
site-to-md ./dist

# Boot the site, crawl it, shut it down
site-to-md --serve "npm start" --out ./public

# Crawl locally but publish elsewhere
site-to-md ./out --base-url https://mysite.com

# Audit what an agent can read — writes nothing
site-to-md https://mysite.com --report

# Fail the build if anything is lost
site-to-md ./out --strict
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--out <dir>` | Output directory | `./<hostname>-md` |
| `--base-url <url>` | Origin the output will be served from; makes every emitted URL absolute | Crawl origin |
| `--title <name>` | Site title for llms.txt | Auto-detected |
| `--desc <text>` | Site description | Auto-detected |
| `--include <glob>` | Include only matching paths (repeatable) | All |
| `--exclude <glob>` | Exclude matching paths (repeatable) | None |
| `--no-ctx` | Skip generating llms-ctx.txt | — |
| `--no-sitemap` | Don't use sitemap.xml for crawling | — |
| `--sitemap-origin <mode>` | `rewrite`, `strict`, or `follow` | `rewrite` |
| `--max-depth <n>` | Max crawl depth | 3 |
| `--concurrency <n>` | Parallel requests | 5 |
| `--strip <selector>` | CSS selectors to strip from extracted content (repeatable) | — |
| `--strip-source` | Strip before extraction instead of after | — |
| `--title-source <s>` | `auto`, `og`, or `title` | `auto` |
| `--serve <command>` | Start a server, crawl it, then stop it | — |
| `--report` | Audit what an agent can read; writes nothing | — |
| `--strict` | Exit non-zero if anything is flagged (for CI) | — |
| `--config <path>` | Config file path | Auto-detect |

## Crawling a local server

```bash
site-to-md --serve "npm start" --out ./public
```

`--serve` starts the command, waits for it to answer, crawls it, and shuts it down — choosing the port itself and passing it as `PORT` (or substituting `{port}` in the command).

Note that static site generators write **absolute production URLs** into `sitemap.xml`. Left alone, crawling `http://localhost:3000` would fetch and mirror your deployed site instead. Sitemap URLs on another origin are therefore rewritten onto the origin being crawled, and the rewrite is reported:

```
• Rewrote 12 sitemap URLs from https://mysite.com to http://localhost:3000
```

Use `--sitemap-origin strict` to refuse and exit non-zero instead, or `follow` to fetch them as listed.

## Diagnostics

Every page is measured before and after extraction, and any collapse is reported:

```
⚠ /pricing — output is 8% of source text (4210 → 337 chars); 4 headings lost, 1 table lost
⚠ /pricing — 3 icons could not be read as included/excluded
```

Add `--strict` to turn any finding into a non-zero exit, which makes the tool safe to run in CI where committed output belongs.

`--report` renders the same checks as an audit, crawling without writing anything:

```
$ site-to-md https://mysite.com --report

  https://mysite.com

  ⚠ 4 pages share the title "Example — the tagline"
      They likely lack a per-page og:title; falling back to <title> would give:
      "Pricing — Example", "About — Example". Re-run with --title-source title to use those.
  ⚠ /about — output is 11% of source text (3800 → 418 chars)
  ✓ 12 pages extracted cleanly
```

### Page titles

Readability prefers `og:title` over `<title>`, so a single site-wide `og:title` gives every page the same name in `llms.txt`. This is detected and repaired from each page's own `<title>` by default; use `--title-source og` or `title` to force either.

## Programmatic API

```js
import { agentReady } from 'site-to-md';

const result = await agentReady({
  url: 'https://mysite.com',
  outDir: './public',
  title: 'My Product',
  description: 'Developer documentation',
  include: ['/docs/**'],
});

console.log(`Generated ${result.pages.length} pages`);
console.log(result.llmsTxt);     // Contents of llms.txt
console.log(result.diagnostics); // Findings from the content-loss guard
```

## Config File

Create `site-to-md.config.js` in your project root:

```js
export default {
  url: 'https://mysite.com',
  outDir: './public',
  baseUrl: 'https://mysite.com',
  title: 'My Product',
  description: 'A brief description for agents',

  include: ['/docs/**'],
  exclude: ['/admin/**'],

  // Free-text lines rendered under the index
  notes: ['Generated from the 2026-01 release.'],

  sections: {
    // A glob, or several
    'Documentation': '/docs/**',
    'Blog': ['/blog/**', '/changelog/**'],

    // Or literal entries, for things that aren't crawled pages at all
    'For agents and developers': [
      {
        title: 'OpenAPI specification',
        url: 'https://api.mysite.com/openapi.json',
        description: 'Every endpoint, request and response',
      },
      { title: 'CLI', url: 'https://www.npmjs.com/package/@mysite/cli' },
    ],
  },

  maxDepth: 3,
  concurrency: 5,
  stripSelectors: ['.cookie-banner', '.ad-wrapper'],
};
```

## Build Pipeline

```json
{
  "scripts": {
    "build": "next build && site-to-md ./out --out ./out --base-url https://mysite.com --strict"
  }
}
```

## Output Format

### `/llms.txt`

Per the [llmstxt.org spec](https://llmstxt.org):

```markdown
# My Product

> Developer documentation for building with My Product

## Documentation

- [Getting Started](/docs/getting-started.html.md): Quick start guide
- [API Reference](/docs/api-reference.html.md): Complete API docs

## For agents and developers

- [OpenAPI specification](https://api.mysite.com/openapi.json): Every endpoint, request and response
```

With `--base-url`, every link above is absolute instead.

### Per-page `.html.md`

Clean markdown extracted from each page — no nav, footer, ads, or scripts.

### `/llms-ctx.txt`

All page content concatenated in a single file for one-shot ingestion by AI agents.

## What is llms.txt?

[llms.txt](https://llmstxt.org) is a proposed standard (by Jeremy Howard) for making websites readable by AI agents. Think of it like `robots.txt` but for LLMs:

- **`/llms.txt`** — A markdown index file listing your site's key pages with descriptions. AI agents read this first to understand what's on your site.
- **`*.html.md`** — Clean markdown versions of each page (same URL + `.md`). No nav, no footer, no JavaScript — just the content.
- **`/llms-ctx.txt`** — All content concatenated in one file for single-prompt ingestion.

Sites like [Anthropic](https://docs.anthropic.com/llms.txt), [Cloudflare](https://developers.cloudflare.com/llms.txt), and [Stripe](https://docs.stripe.com/llms.txt) already have `/llms.txt` files. `site-to-md` generates yours automatically.

## Development

```bash
npm install
npm test        # builds, then runs the test suite against dist/
```

## License

MIT © [Stratus Labs](https://stratuslabs.io)
