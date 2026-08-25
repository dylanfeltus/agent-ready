import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { crawlSite } from "./crawl.js";
import { extractPage, extractLocalFile, type ExtractionReport } from "./extract.js";
import { generateLlmsTxt, generateLlmsCtx, mirrorPath } from "./generate.js";
import {
  Diagnostics,
  checkContentLoss,
  checkConversionLoss,
  checkDuplicateTitles,
} from "./diagnostics.js";
import type { AgentReadyConfig, PageResult, GenerateResult } from "./types.js";

export type { AgentReadyConfig, PageResult, GenerateResult };
export { Diagnostics } from "./diagnostics.js";
export type { Diagnostic } from "./diagnostics.js";
export { ForeignSitemapError } from "./crawl.js";

/** Walk a directory recursively for HTML files */
function walkDir(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...walkDir(full));
    } else if (extname(entry.name).match(/\.html?$/)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Rewrite crawl-origin URLs in a page mirror to the publish origin.
 *
 * Links are resolved against the crawl URL during extraction, so a localhost
 * crawl otherwise bakes `http://localhost:3000/pricing` into every mirror.
 */
function rewriteMarkdownOrigin(markdown: string, from: string, to: string): string {
  if (from === to) return markdown;
  return markdown.split(from).join(to);
}

/**
 * Resolve titles across the whole site.
 *
 * Readability prefers og:title and only falls back to <title> when no
 * metadata title exists at all. A single site-wide og:title in a root layout
 * therefore gives every page the same name — a correct-looking, useless index.
 * Only visible once all pages are in hand, which is why it happens here.
 */
function resolveTitles(pages: PageResult[], diagnostics: Diagnostics): void {
  const groups = new Map<string, PageResult[]>();
  for (const page of pages) {
    if (!groups.has(page.title)) groups.set(page.title, []);
    groups.get(page.title)!.push(page);
  }

  const repaired: PageResult[] = [];
  for (const [title, group] of groups) {
    if (group.length < 2) continue;
    const fallbacks = group.map((p) => p.fallbackTitle?.trim()).filter(Boolean);
    const allDistinct =
      fallbacks.length === group.length && new Set(fallbacks).size === group.length;
    if (!allDistinct) continue;

    for (const page of group) {
      const next = page.fallbackTitle!.trim();
      // The mirror's H1 was written from the old title.
      page.markdown = page.markdown.replace(`# ${title}`, `# ${next}`);
      page.title = next;
      repaired.push(page);
    }
  }

  if (repaired.length > 0) {
    diagnostics.add({
      level: "info",
      code: "title-fallback",
      message: `${repaired.length} pages shared one og:title; used each page's <title> instead`,
      detail: "Add a per-page og:title to control this, or pass --title-source og to keep the shared one.",
    });
  }

  // Anything still duplicated could not be repaired — report it.
  checkDuplicateTitles(
    pages.map((p) => ({ path: p.path, title: p.title, fallbackTitle: p.fallbackTitle })),
    diagnostics
  );
}

/** Main function — crawl/read + extract + generate */
export async function agentReady(config: AgentReadyConfig): Promise<GenerateResult> {
  // Default output dir: use URL hostname if available, otherwise generic
  let defaultOut = "./site-to-md-output";
  if (config.url) {
    try {
      const hostname = new URL(config.url).hostname.replace(/^www\./, "");
      defaultOut = `./${hostname}-md`;
    } catch { /* fall back to default */ }
  }
  const outDir = resolve(config.outDir || defaultOut);
  const diagnostics = new Diagnostics();
  const pages: PageResult[] = [];
  const reports = new Map<string, ExtractionReport>();

  if (config.url) {
    // Crawl a live website
    const crawled = await crawlSite(config, diagnostics);

    for (const { url, html } of crawled) {
      const outcome = extractPage(url, html, config);
      if (!outcome) {
        diagnostics.add({
          level: "warn",
          code: "no-content",
          page: new URL(url).pathname,
          message: `${new URL(url).pathname} — no extractable content, page skipped`,
        });
        continue;
      }
      pages.push(outcome.page);
      reports.set(outcome.page.path, outcome.report);
    }
  } else if (config.dir) {
    // Read local directory
    const dir = resolve(config.dir);
    const htmlFiles = walkDir(dir);

    for (const file of htmlFiles) {
      const html = readFileSync(file, "utf-8");
      const outcome = extractLocalFile(file, html, dir, config);
      if (!outcome) {
        diagnostics.add({
          level: "warn",
          code: "no-content",
          page: file.replace(dir, ""),
          message: `${file.replace(dir, "")} — no extractable content, file skipped`,
        });
        continue;
      }
      pages.push(outcome.page);
      reports.set(outcome.page.path, outcome.report);
    }
  } else {
    throw new Error("Either 'url' or 'dir' must be specified");
  }

  if (pages.length === 0) {
    throw new Error("No pages with extractable content found");
  }

  // Sort pages: index first, then alphabetically
  pages.sort((a, b) => {
    if (a.path === "/" || a.path === "/index") return -1;
    if (b.path === "/" || b.path === "/index") return 1;
    return a.path.localeCompare(b.path);
  });

  if (config.titleSource !== "og" && config.titleSource !== "title") {
    resolveTitles(pages, diagnostics);
  } else {
    checkDuplicateTitles(
      pages.map((p) => ({ path: p.path, title: p.title, fallbackTitle: p.fallbackTitle })),
      diagnostics
    );
  }

  // Content-loss guard, per page.
  for (const page of pages) {
    const report = reports.get(page.path);
    if (!report) continue;
    checkContentLoss(page.path, report.source, report.output, diagnostics);
    checkConversionLoss(page.path, report.lostIcons, report.degradedTables, diagnostics);
  }

  // Rewrite mirrors to the publish origin when it differs from the crawl.
  if (config.baseUrl && config.url) {
    try {
      const from = new URL(config.url).origin;
      const to = new URL(config.baseUrl).origin;
      for (const page of pages) {
        page.markdown = rewriteMarkdownOrigin(page.markdown, from, to);
      }
    } catch { /* malformed baseUrl — leave mirrors alone */ }
  }

  // Generate output files
  const llmsTxt = generateLlmsTxt(pages, config);
  const llmsCtx = config.llmsCtx !== false ? generateLlmsCtx(pages, config) : undefined;

  const result: GenerateResult = {
    pages,
    llmsTxt,
    llmsCtx,
    outputDir: outDir,
    diagnostics: diagnostics.all,
  };

  // An audit inspects; it does not write.
  if (config.report) return result;

  mkdirSync(outDir, { recursive: true });

  if (config.llmsTxt !== false) {
    writeFileSync(join(outDir, "llms.txt"), llmsTxt, "utf-8");
  }

  if (llmsCtx) {
    writeFileSync(join(outDir, "llms-ctx.txt"), llmsCtx, "utf-8");
  }

  // Write per-page .md files
  for (const page of pages) {
    const fullPath = join(outDir, mirrorPath(page).replace(/^\//, ""));
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, page.markdown, "utf-8");
  }

  return result;
}
