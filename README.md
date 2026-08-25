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

### Why `.html.md`?

It looks like a mistake, but it is the [llmstxt.org](https://llmstxt.org) convention: the markdown mirror of a page lives at that page's own URL with `.md`
appended. `/pricing.html` gets `/pricing.html.md`, so an agent that knows a page's URL can find its clean version by appending one extension — no index lookup, no
guessing. Pages served without an extension still get `.html.md`, keeping one predictable rule across the whole site.

## What It Does

1. **Crawls your site** — follows links or uses `sitemap.xml` if available
2. **Extracts content** — strips nav, footer, ads, scripts using [Mozilla Readability](https://github.com/mozilla/readability) (same as Firefox Reader View)
3. **Converts to markdown** — clean, structured markdown via [Turndown](https://github.com/mixmark-io/turndown), including comparison tables
4. **Checks its own work** — warns when a page loses content in extraction (see [Content-loss guard](#content-loss-guard))
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

# Audit what an agent can actually read — writes nothing
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
| `--sitemap-origin <mode>` | `rewrite`, `strict`, or `follow` — see [Crawling a local server](#crawling-a-local-server) | `rewrite` |
| `--max-depth <n>` | Max crawl depth | 3 |
| `--concurrency <n>` | Parallel requests | 5 |
| `--strip <selector>` | CSS selectors to strip from extracted content (repeatable) | — |
| `--strip-source` | Strip before extraction instead of after (pre-0.2 behaviour) | — |
| `--title-source <s>` | `auto`, `og`, or `title` — see [Page titles](#page-titles) | `auto` |
| `--serve <command>` | Start a server, crawl it, then stop it | — |
| `--report` | Audit what an agent can read; writes nothing | — |
| `--strict` | Exit non-zero if anything is flagged (for CI) | — |
| `--config <path>` | Config file path | Auto-detect |

## Crawling a local server

Static site generators — Next.js, Astro, Nuxt and Hugo among them — write **absolute production URLs** into `sitemap.xml`. Following those verbatim means
`site-to-md http://localhost:3000` fetches `https://yoursite.com/...` and mirrors **production**, producing well-formed output that describes a build other than the
one in front of you.

By default, sitemap URLs on a different origin are rewritten onto the origin being crawled, and the rewrite is reported:

```
• Rewrote 12 sitemap URLs from https://mysite.com to http://localhost:3000
```

Use `--sitemap-origin strict` to refuse and exit non-zero instead, or `--sitemap-origin follow` for the pre-0.2 behaviour.

### `--serve`

`--serve` handles the boot/wait/crawl/teardown cycle:

```bash
site-to-md --serve "npm start" --out ./public
```

Two details matter, and both are handled for you:

- **The port is reserved before the command starts** and passed via `PORT` (and by substituting `{port}` in the command). Many dev servers — `next start` among
  them — do not fail on a busy port; they print a notice and quietly move to the next one, leaving you crawling whatever was already listening.
- **The whole process group is terminated** on teardown. `next start` forks, so killing only the spawned process leaves the real server holding the port and the
  next run reads a stale build.

## Content-loss guard

The failure mode this tool has to defend against is not crashing — it is producing a convincing document that is wrong. Every page is measured before and after
extraction, and any collapse is reported:

```
⚠ /pricing — output is 8% of source text (4210 → 337 chars); 4 headings lost, 1 table lost
⚠ /pricing — 8 icons could not be read as included/excluded
```

Add `--strict` to turn any finding into a non-zero exit, which makes the tool safe to run in CI where committed output belongs.

### `--report`

The same checks, rendered as an audit. It crawls and writes nothing:

```
$ site-to-md https://mysite.com --report

  https://mysite.com

  ⚠ 4 pages share the title "Example — the tagline"
      They likely lack a per-page og:title; falling back to <title> would give:
      "Pricing — Example", "About — Example". Re-run with --title-source title to use those.
  ⚠ /about — output is 11% of source text (3800 → 418 chars)
  ✓ 12 pages extracted cleanly
```

## Comparison tables

Pricing pages and feature matrices are the content most likely to be read by an agent acting on your behalf, and the easiest to lose silently. Two things are
handled explicitly:

- **Tables are emitted as markdown tables.** Turndown has no table support of its own, so a preserved HTML table would otherwise be flattened into a vertical run
  of text with every row and column boundary gone.
- **Icon-only cells keep their meaning.** A cell whose only content is a tick or cross `<svg>` produces no text, which erases the meaning of a row while leaving its
  label intact — that is how a Free plan comes to look like it includes everything. Icons are resolved to `✓` / `—` from `aria-label`, `title`, `alt`, `<use href>`,
  or class names.

An icon with no readable signal is reported rather than guessed:

```
⚠ /pricing — 3 icons could not be read as included/excluded
    Give each icon an aria-label, title, or alt so its meaning survives conversion.
```

## Page titles

Readability prefers `og:title` and falls back to `<title>` only when no metadata title exists at all. A single site-wide `og:title` in a root layout — common in the
Next.js App Router, where a child page must redeclare the whole `openGraph` object to override it — therefore gives **every page the same name**, producing a
correct-looking but useless index.

By default (`--title-source auto`) this is detected and repaired from each page's own `<title>`, and the repair is reported:

```
• 4 pages shared one og:title; used each page's <title> instead
```

Force either source with `--title-source og` or `--title-source title`.

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
console.log(result.llmsTxt);    // Contents of llms.txt
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

    // Or literal entries, for things that are not crawled pages at all
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

## Upgrading to 0.2

Three behaviour changes, all of them fixes for silently wrong output:

- **`--strip` now applies after extraction.** Previously user selectors were removed from the source DOM before Readability ran, which could change which node
  Readability scored as the article — removing one small block could delete the section around it. Selectors now affect only what they match. Pass `--strip-source`
  for the old behaviour.
- **Sitemap URLs on another origin are rewritten to the crawl origin** rather than followed. Pass `--sitemap-origin follow` for the old behaviour.
- **Pages sharing one `og:title` are retitled from their own `<title>`.** Pass `--title-source og` for the old behaviour.

## Development

```bash
npm install
npm test        # builds, then runs the test suite against dist/
```

## License

MIT © [Stratus Labs](https://stratuslabs.io)
