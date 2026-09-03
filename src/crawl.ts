import { JSDOM } from "jsdom";
import type { Diagnostics } from "./diagnostics.js";
import { matchesAnyGlob } from "./glob.js";
import type { AgentReadyConfig } from "./types.js";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_UA = "AgentReady/0.1 (+https://github.com/dylanfeltus/site-to-md)";

interface CrawlResult {
  url: string;
  html: string;
}

/** Thrown when a sitemap points off-origin and sitemapOrigin is "strict". */
export class ForeignSitemapError extends Error {
  constructor(crawlOrigin: string, foreign: string[]) {
    const sample = foreign.slice(0, 3).join(", ");
    super(
      `Sitemap lists URLs on a different origin than the one being crawled.\n` +
        `  Crawling: ${crawlOrigin}\n` +
        `  Sitemap lists: ${sample}${foreign.length > 3 ? ` (and ${foreign.length - 3} more)` : ""}\n\n` +
        `  Static site generators emit absolute production URLs, so crawling a local\n` +
        `  server would mirror production instead of the build in front of you.\n` +
        `  Use --sitemap-origin rewrite (the default) to point them at ${crawlOrigin},\n` +
        `  or --no-sitemap to crawl by following links.`
    );
    this.name = "ForeignSitemapError";
  }
}

/** Fetch a single URL */
async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": DEFAULT_UA },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html") && !ct.includes("text/xml") && !ct.includes("application/xml") && !ct.includes("application/xhtml")) {
    throw new Error(`Not HTML: ${ct} for ${url}`);
  }
  return res.text();
}

/** Parse sitemap.xml and return list of URLs, as listed. */
async function parseSitemap(
  baseUrl: string,
  mode: AgentReadyConfig["sitemapOrigin"],
  diagnostics?: Diagnostics
): Promise<string[]> {
  const urls: string[] = [];
  const sitemapUrls = [
    new URL("/sitemap.xml", baseUrl).href,
    new URL("/sitemap_index.xml", baseUrl).href,
  ];

  for (const sitemapUrl of sitemapUrls) {
    try {
      const xml = await fetchPage(sitemapUrl);
      // Check for sitemap index (contains other sitemaps)
      const indexMatches = xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/gi);
      const childSitemaps = [...indexMatches].map((m) => m[1].trim());

      if (childSitemaps.length > 0) {
        // A sitemap index on a local server lists production URLs for its
        // children too. Validate their origins BEFORE rewriting or fetching:
        // otherwise strict mode rewrites the reference away, the fetch quietly
        // 404s, and the run falls back to link crawling having promised to
        // refuse the foreign sitemap it was just handed.
        const foreignChildren = childSitemaps.filter((u) => isForeign(u, baseUrl));
        if (foreignChildren.length > 0) {
          if (mode === "strict") {
            throw new ForeignSitemapError(new URL(baseUrl).origin, foreignChildren);
          }
          if (mode !== "follow") {
            diagnostics?.add({
              level: "info",
              code: "sitemap-rewritten",
              message:
                `Rewrote ${foreignChildren.length} child sitemap reference` +
                `${foreignChildren.length !== 1 ? "s" : ""} onto ${new URL(baseUrl).origin}`,
              detail: "The sitemap index lists absolute production URLs.",
            });
          }
        }

        // Recurse into child sitemaps, reaching them through the crawl origin
        // unless the caller explicitly asked to follow the sitemap as written.
        for (const childUrl of childSitemaps) {
          const target =
            mode === "follow" ? childUrl : rewriteOrigin(childUrl, baseUrl) || childUrl;
          try {
            const childXml = await fetchPage(target);
            const locMatches = childXml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/gi);
            for (const m of locMatches) urls.push(m[1].trim());
          } catch { /* skip broken child sitemaps */ }
        }
      } else {
        // Direct sitemap with <url><loc> entries
        const locMatches = xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/gi);
        for (const m of locMatches) urls.push(m[1].trim());
      }

      if (urls.length > 0) break; // found a working sitemap
    } catch (err) {
      // A deliberate refusal is an answer, not a reason to try the next path.
      if (err instanceof ForeignSitemapError) throw err;
      /* try next */
    }
  }

  return urls;
}

/** True when a URL sits on a different origin than the crawl. */
function isForeign(url: string, crawlOrigin: string): boolean {
  try {
    return new URL(url).origin !== new URL(crawlOrigin).origin;
  } catch {
    return false;
  }
}

/** Move a URL onto the crawl origin, preserving path, query and hash. */
function rewriteOrigin(url: string, origin: string): string | null {
  try {
    const parsed = new URL(url);
    const base = new URL(origin);
    if (parsed.origin === base.origin) return parsed.href;
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    parsed.port = base.port;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Reconcile sitemap URLs with the origin actually being crawled.
 *
 * Next.js, Astro, Nuxt and Hugo all emit absolute production URLs in
 * sitemap.xml by default. Following them verbatim means `site-to-md
 * http://localhost:3000` silently mirrors the deployed site — well-formed
 * output describing a build that is not the one in front of you.
 */
export function reconcileSitemapUrls(
  urls: string[],
  crawlOrigin: string,
  mode: AgentReadyConfig["sitemapOrigin"],
  diagnostics?: Diagnostics
): string[] {
  if (urls.length === 0) return urls;

  const base = new URL(crawlOrigin);
  const foreign = urls.filter((u) => {
    try { return new URL(u).origin !== base.origin; } catch { return false; }
  });

  if (foreign.length === 0) return urls;

  if (mode === "follow") {
    diagnostics?.add({
      level: "warn",
      code: "sitemap-foreign-origin",
      message: `${foreign.length} sitemap URLs point at another origin and are being followed as listed`,
      detail: `Output will describe ${new URL(foreign[0]).origin}, not ${base.origin}.`,
    });
    return urls;
  }

  if (mode === "strict") {
    throw new ForeignSitemapError(base.origin, foreign);
  }

  // Default: rewrite onto the crawl origin, which is almost always the intent.
  const foreignOrigin = new URL(foreign[0]).origin;
  diagnostics?.add({
    level: "info",
    code: "sitemap-rewritten",
    message: `Rewrote ${foreign.length} sitemap URL${foreign.length !== 1 ? "s" : ""} from ${foreignOrigin} to ${base.origin}`,
    detail: "The sitemap lists absolute production URLs. Use --sitemap-origin strict to refuse instead.",
  });

  return urls.map((u) => rewriteOrigin(u, crawlOrigin) || u);
}

/** Extract links from HTML page */
function extractLinks(html: string, baseUrl: string): string[] {
  const dom = new JSDOM(html, { url: baseUrl });
  const anchors = dom.window.document.querySelectorAll("a[href]");
  const links: string[] = [];
  const base = new URL(baseUrl);

  for (const a of anchors) {
    try {
      const href = a.getAttribute("href");
      if (!href) continue;
      const resolved = new URL(href, baseUrl);
      // Same origin only, no fragments, no query params for dedup
      if (resolved.origin !== base.origin) continue;
      if (resolved.pathname.match(/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|css|js|ico|woff|woff2|ttf|eot|mp3|mp4|avi)$/i)) continue;
      resolved.hash = "";
      links.push(resolved.href);
    } catch { /* invalid URL */ }
  }

  return [...new Set(links)];
}

/** Crawl a website starting from a URL */
export async function crawlSite(
  config: AgentReadyConfig,
  diagnostics?: Diagnostics
): Promise<CrawlResult[]> {
  const baseUrl = config.url!;
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const results: CrawlResult[] = [];
  const visited = new Set<string>();
  const crawlOrigin = new URL(baseUrl).origin;

  // Normalize URL for dedup
  const normalize = (u: string) => {
    try {
      const url = new URL(u);
      url.hash = "";
      // Remove trailing slash except for root
      if (url.pathname !== "/" && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.slice(0, -1);
      }
      return url.href;
    } catch { return u; }
  };

  // Try sitemap first
  const sitemapMode = config.sitemapOrigin ?? "rewrite";
  let seedUrls: string[] = [];
  if (config.sitemap !== false) {
    seedUrls = reconcileSitemapUrls(
      await parseSitemap(baseUrl, sitemapMode, diagnostics),
      baseUrl,
      sitemapMode,
      diagnostics
    );
  }

  // Queue: [url, depth]
  const queue: [string, number][] = seedUrls.length > 0
    ? seedUrls.map((u) => [u, 0] as [string, number])
    : [[baseUrl, 0]];

  const failures: string[] = [];

  const processUrl = async (url: string, depth: number) => {
    const normalized = normalize(url);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    // Belt and braces: sitemap rewriting should have handled this already, so
    // nothing off-origin is fetched unless the caller opted into "follow".
    if (sitemapMode !== "follow" && new URL(normalized).origin !== crawlOrigin) return;

    const pathname = new URL(normalized).pathname;

    // Apply include/exclude filters
    if (config.include && config.include.length > 0) {
      if (!matchesAnyGlob(pathname, config.include)) return;
    }
    if (config.exclude && config.exclude.length > 0) {
      if (matchesAnyGlob(pathname, config.exclude)) return;
    }

    try {
      const html = await fetchPage(normalized);
      results.push({ url: normalized, html });

      // Extract and queue links if within depth limit and no sitemap
      if (depth < maxDepth && seedUrls.length === 0) {
        const links = extractLinks(html, normalized);
        for (const link of links) {
          if (!visited.has(normalize(link))) {
            queue.push([link, depth + 1]);
          }
        }
      }
    } catch (err) {
      failures.push(`${normalized} — ${err instanceof Error ? err.message : err}`);
    }
  };

  // Process queue with concurrency limit
  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);
    await Promise.all(batch.map(([url, depth]) => processUrl(url, depth)));
  }

  // Pages that were listed but could not be fetched used to vanish without
  // trace, which reads as "this page has no content" in the output.
  if (failures.length > 0) {
    diagnostics?.add({
      level: "warn",
      code: "fetch-failed",
      message: `${failures.length} page${failures.length !== 1 ? "s" : ""} could not be fetched`,
      detail: failures.slice(0, 5).join("; "),
    });
  }

  return results;
}
