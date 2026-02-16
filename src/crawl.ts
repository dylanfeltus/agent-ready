import { JSDOM } from "jsdom";
import type { AgentReadyConfig } from "./types.js";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_UA = "AgentReady/0.1 (+https://github.com/dylanfeltus/agent-ready)";

interface CrawlResult {
  url: string;
  html: string;
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

/** Parse sitemap.xml and return list of URLs */
async function parseSitemap(baseUrl: string): Promise<string[]> {
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
        // Recurse into child sitemaps
        for (const childUrl of childSitemaps) {
          try {
            const childXml = await fetchPage(childUrl);
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
    } catch { /* try next */ }
  }

  return urls;
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

/** Check if URL matches include/exclude patterns */
function matchesPatterns(pathname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Convert glob-like pattern to regex
    const regex = new RegExp(
      "^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$"
    );
    return regex.test(pathname);
  });
}

/** Crawl a website starting from a URL */
export async function crawlSite(config: AgentReadyConfig): Promise<CrawlResult[]> {
  const baseUrl = config.url!;
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const results: CrawlResult[] = [];
  const visited = new Set<string>();

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
  let seedUrls: string[] = [];
  if (config.sitemap !== false) {
    seedUrls = await parseSitemap(baseUrl);
  }

  // Queue: [url, depth]
  const queue: [string, number][] = seedUrls.length > 0
    ? seedUrls.map((u) => [u, 0] as [string, number])
    : [[baseUrl, 0]];

  const processUrl = async (url: string, depth: number) => {
    const normalized = normalize(url);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    const pathname = new URL(normalized).pathname;

    // Apply include/exclude filters
    if (config.include && config.include.length > 0) {
      if (!matchesPatterns(pathname, config.include)) return;
    }
    if (config.exclude && config.exclude.length > 0) {
      if (matchesPatterns(pathname, config.exclude)) return;
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
      // Skip failed pages silently
    }
  };

  // Process queue with concurrency limit
  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);
    await Promise.all(batch.map(([url, depth]) => processUrl(url, depth)));
  }

  return results;
}
