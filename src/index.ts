import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { crawlSite } from "./crawl.js";
import { extractPage, extractLocalFile } from "./extract.js";
import { generateLlmsTxt, generateLlmsCtx } from "./generate.js";
import type { AgentReadyConfig, PageResult, GenerateResult } from "./types.js";

export type { AgentReadyConfig, PageResult, GenerateResult };

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

/** Main function — crawl/read + extract + generate */
export async function agentReady(config: AgentReadyConfig): Promise<GenerateResult> {
  // Default output dir: use URL hostname if available, otherwise generic
  let defaultOut = "./site-to-md-output";
  if (config.url) {
    try {
      const hostname = new URL(config.url).hostname.replace(/^www\./, "");
      defaultOut = `./${hostname}`;
    } catch { /* fall back to default */ }
  }
  const outDir = resolve(config.outDir || defaultOut);
  const pages: PageResult[] = [];

  if (config.url) {
    // Crawl a live website
    const crawled = await crawlSite(config);

    for (const { url, html } of crawled) {
      const result = extractPage(url, html, config);
      if (result) pages.push(result);
    }
  } else if (config.dir) {
    // Read local directory
    const dir = resolve(config.dir);
    const htmlFiles = walkDir(dir);

    for (const file of htmlFiles) {
      const html = readFileSync(file, "utf-8");
      const result = extractLocalFile(file, html, dir, config);
      if (result) pages.push(result);
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

  // Generate output files
  const llmsTxt = generateLlmsTxt(pages, config);
  const llmsCtx = config.llmsCtx !== false ? generateLlmsCtx(pages, config) : undefined;

  // Write files
  mkdirSync(outDir, { recursive: true });

  // Write llms.txt
  if (config.llmsTxt !== false) {
    writeFileSync(join(outDir, "llms.txt"), llmsTxt, "utf-8");
  }

  // Write llms-ctx.txt
  if (llmsCtx) {
    writeFileSync(join(outDir, "llms-ctx.txt"), llmsCtx, "utf-8");
  }

  // Write per-page .md files
  for (const page of pages) {
    const mdPath = page.path === "/" || page.path === "/index"
      ? "index.html.md"
      : `${page.path.replace(/^\//, "")}.html.md`;
    const fullPath = join(outDir, mdPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, page.markdown, "utf-8");
  }

  return { pages, llmsTxt, llmsCtx, outputDir: outDir };
}
