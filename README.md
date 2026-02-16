# agent-ready 🤖

Make any website AI-agent-readable. Generates `/llms.txt` + clean markdown for every page.

> `robots.txt` told search engines what to crawl. `llms.txt` tells AI agents what to read. This tool generates both automatically.

## Quick Start

```bash
npx agent-ready https://mysite.com
```

That's it. Zero config. You'll get:

```
agent-ready-output/
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

## What It Does

1. **Crawls your site** — follows links or uses `sitemap.xml` if available
2. **Extracts content** — strips nav, footer, ads, scripts using [Mozilla Readability](https://github.com/mozilla/readability) (same as Firefox Reader View)
3. **Converts to markdown** — clean, structured markdown via [Turndown](https://github.com/mixmark-io/turndown)
4. **Generates `/llms.txt`** — per the [llmstxt.org](https://llmstxt.org) spec
5. **Generates per-page `.html.md` files** — per the spec convention
6. **Generates `/llms-ctx.txt`** — all content inline for single-prompt ingestion

## Install

```bash
# Use directly with npx (no install needed)
npx agent-ready https://mysite.com

# Or install globally
npm install -g agent-ready

# Or as a project dependency
npm install agent-ready
```

## CLI Usage

```bash
# Crawl a live website
agent-ready https://docs.mysite.com

# Process local build output
agent-ready ./dist

# Customize output
agent-ready https://mysite.com \
  --out ./public \
  --title "My Product" \
  --desc "Developer documentation for My Product"

# Filter pages
agent-ready https://mysite.com \
  --include "/docs/**" \
  --include "/blog/**" \
  --exclude "/admin/**"

# Skip context file
agent-ready https://mysite.com --no-ctx
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--out <dir>` | Output directory | `./agent-ready-output` |
| `--title <name>` | Site title for llms.txt | Auto-detected |
| `--desc <text>` | Site description | Auto-detected |
| `--include <glob>` | Include only matching paths (repeatable) | All |
| `--exclude <glob>` | Exclude matching paths (repeatable) | None |
| `--no-ctx` | Skip generating llms-ctx.txt | — |
| `--no-sitemap` | Don't use sitemap.xml for crawling | — |
| `--max-depth <n>` | Max crawl depth | 3 |
| `--concurrency <n>` | Parallel requests | 5 |
| `--strip <selector>` | CSS selectors to strip (repeatable) | — |
| `--config <path>` | Config file path | Auto-detect |

## Programmatic API

```js
import { agentReady } from 'agent-ready';

const result = await agentReady({
  url: 'https://mysite.com',
  outDir: './public',
  title: 'My Product',
  description: 'Developer documentation',
  include: ['/docs/**'],
});

console.log(`Generated ${result.pages.length} pages`);
console.log(result.llmsTxt); // Contents of llms.txt
```

## Config File

Create `agent-ready.config.js` in your project root:

```js
export default {
  url: 'https://mysite.com',
  outDir: './public',
  title: 'My Product',
  description: 'A brief description for agents',

  include: ['/docs/**', '/blog/**'],
  exclude: ['/admin/**'],

  sections: {
    'Documentation': '/docs/**',
    'Blog': '/blog/**',
    'API Reference': '/api-docs/**',
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
    "build": "next build && agent-ready ./out --out ./out"
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

## Blog

- [Hello World](/blog/hello-world.html.md): Our launch announcement
```

### Per-page `.html.md`

Clean markdown extracted from each page — no nav, footer, ads, or scripts.

### `/llms-ctx.txt`

All page content concatenated in a single file for one-shot ingestion by AI agents.

## What is llms.txt?

[llms.txt](https://llmstxt.org) is a proposed standard (by Jeremy Howard) for making websites readable by AI agents. Think of it like `robots.txt` but for LLMs:

- **`/llms.txt`** — A markdown index file listing your site's key pages with descriptions. AI agents read this first to understand what's on your site.
- **`*.html.md`** — Clean markdown versions of each page (same URL + `.md`). No nav, no footer, no JavaScript — just the content.
- **`/llms-ctx.txt`** — All content concatenated in one file for single-prompt ingestion.

Sites like [Anthropic](https://docs.anthropic.com/llms.txt), [Cloudflare](https://developers.cloudflare.com/llms.txt), and [Stripe](https://docs.stripe.com/llms.txt) already have `/llms.txt` files. `agent-ready` generates yours automatically.

## License

MIT © [Stratus Labs](https://stratuslabs.co)
