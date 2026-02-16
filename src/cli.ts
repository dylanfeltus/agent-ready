#!/usr/bin/env node

import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { agentReady } from "./index.js";
import type { AgentReadyConfig } from "./types.js";

const VERSION = "0.1.0";

function printHelp() {
  console.log(`
  site-to-md v${VERSION}
  Make any website AI-agent-readable.

  Usage:
    site-to-md <url>              Crawl a website and generate markdown
    site-to-md <directory>        Process local HTML files
    site-to-md --help             Show this help

  Options:
    --out <dir>         Output directory (default: ./<hostname>)
    --title <name>      Site title for llms.txt header
    --desc <text>       Site description for llms.txt
    --include <glob>    Include only matching paths (repeatable)
    --exclude <glob>    Exclude matching paths (repeatable)
    --no-ctx            Skip generating llms-ctx.txt
    --no-sitemap        Don't use sitemap.xml for crawling
    --max-depth <n>     Max crawl depth (default: 3)
    --concurrency <n>   Parallel requests (default: 5)
    --strip <selector>  Additional CSS selectors to strip (repeatable)
    --config <path>     Path to config file
    --version           Show version
    --help              Show this help

  Examples:
    npx site-to-md https://docs.mysite.com
    npx site-to-md ./dist --out ./public
    npx site-to-md https://mysite.com --include "/docs/**" --include "/blog/**"
    npx site-to-md https://mysite.com --title "My Product" --desc "Product docs"
  `);
}

function parseArgs(argv: string[]): { target?: string; flags: Record<string, string | string[] | boolean> } {
  const flags: Record<string, string | string[] | boolean> = {};
  let target: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (arg === "--no-ctx") {
      flags.noCtx = true;
    } else if (arg === "--no-sitemap") {
      flags.noSitemap = true;
    } else if (arg === "--out" && argv[i + 1]) {
      flags.out = argv[++i];
    } else if (arg === "--title" && argv[i + 1]) {
      flags.title = argv[++i];
    } else if (arg === "--desc" && argv[i + 1]) {
      flags.desc = argv[++i];
    } else if (arg === "--max-depth" && argv[i + 1]) {
      flags.maxDepth = argv[++i];
    } else if (arg === "--concurrency" && argv[i + 1]) {
      flags.concurrency = argv[++i];
    } else if (arg === "--config" && argv[i + 1]) {
      flags.config = argv[++i];
    } else if (arg === "--include" && argv[i + 1]) {
      if (!Array.isArray(flags.include)) flags.include = [];
      (flags.include as string[]).push(argv[++i]);
    } else if (arg === "--exclude" && argv[i + 1]) {
      if (!Array.isArray(flags.exclude)) flags.exclude = [];
      (flags.exclude as string[]).push(argv[++i]);
    } else if (arg === "--strip" && argv[i + 1]) {
      if (!Array.isArray(flags.strip)) flags.strip = [];
      (flags.strip as string[]).push(argv[++i]);
    } else if (!arg.startsWith("-") && !target) {
      target = arg;
    }
  }

  return { target, flags };
}

async function loadConfigFile(configPath?: string): Promise<Partial<AgentReadyConfig>> {
  const paths = configPath
    ? [resolve(configPath)]
    : [
        resolve("site-to-md.config.js"),
        resolve("site-to-md.config.mjs"),
        resolve(".site-to-md.json"),
      ];

  for (const p of paths) {
    if (existsSync(p)) {
      if (p.endsWith(".json")) {
        return JSON.parse(readFileSync(p, "utf-8"));
      }
      const mod = await import(p);
      return mod.default || mod;
    }
  }

  return {};
}

async function main() {
  const { target, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (flags.help || !target) {
    printHelp();
    process.exit(flags.help ? 0 : 1);
  }

  // Load config file
  const fileConfig = await loadConfigFile(flags.config as string | undefined);

  // Determine if target is URL or directory
  const isUrl = target.startsWith("http://") || target.startsWith("https://");
  const isDir = !isUrl && existsSync(target);

  if (!isUrl && !isDir) {
    console.error(`Error: "${target}" is not a valid URL or directory.`);
    process.exit(1);
  }

  // Merge config: file < CLI flags
  const config: AgentReadyConfig = {
    ...fileConfig,
    ...(isUrl ? { url: target } : { dir: resolve(target) }),
    ...(flags.out ? { outDir: flags.out as string } : {}),
    ...(flags.title ? { title: flags.title as string } : {}),
    ...(flags.desc ? { description: flags.desc as string } : {}),
    ...(flags.noCtx ? { llmsCtx: false } : {}),
    ...(flags.noSitemap ? { sitemap: false } : {}),
    ...(flags.maxDepth ? { maxDepth: parseInt(flags.maxDepth as string, 10) } : {}),
    ...(flags.concurrency ? { concurrency: parseInt(flags.concurrency as string, 10) } : {}),
    ...(Array.isArray(flags.include) ? { include: flags.include as string[] } : {}),
    ...(Array.isArray(flags.exclude) ? { exclude: flags.exclude as string[] } : {}),
    ...(Array.isArray(flags.strip) ? { stripSelectors: flags.strip as string[] } : {}),
  };

  const label = isUrl ? target : resolve(target);

  // Dynamic imports for chalk and ora (ESM)
  const chalk = (await import("chalk")).default;
  const { default: ora } = await import("ora");

  console.log("");
  console.log(chalk.bold("  🤖 site-to-md"));
  console.log(chalk.gray(`  Making ${label} agent-readable...\n`));

  const spinner = ora({ text: isUrl ? "Crawling site..." : "Reading HTML files...", indent: 2 }).start();

  try {
    const startTime = Date.now();
    const result = await agentReady(config);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    spinner.succeed(chalk.green(`Done in ${elapsed}s`));
    console.log("");
    console.log(chalk.bold("  Output:"));
    console.log(chalk.gray(`  📂 ${result.outputDir}`));
    console.log(chalk.gray(`  📄 llms.txt`));
    if (result.llmsCtx) console.log(chalk.gray(`  📄 llms-ctx.txt`));
    console.log(chalk.gray(`  📝 ${result.pages.length} page${result.pages.length !== 1 ? "s" : ""} converted to markdown`));
    console.log("");

    // Show first few pages
    const preview = result.pages.slice(0, 5);
    for (const page of preview) {
      const mdPath = page.path === "/" || page.path === "/index"
        ? "index.html.md"
        : `${page.path.replace(/^\//, "")}.html.md`;
      console.log(chalk.gray(`     ${mdPath}`));
    }
    if (result.pages.length > 5) {
      console.log(chalk.gray(`     ... and ${result.pages.length - 5} more`));
    }
    console.log("");
  } catch (err) {
    spinner.fail(chalk.red("Failed"));
    console.error(chalk.red(`\n  ${err instanceof Error ? err.message : err}\n`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
