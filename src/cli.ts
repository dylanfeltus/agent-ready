#!/usr/bin/env node

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { agentReady } from "./index.js";
import { ForeignSitemapError } from "./crawl.js";
import { Diagnostics, renderReport, renderWarnings } from "./diagnostics.js";
import { startServer, type ServeHandle } from "./serve.js";
import type { AgentReadyConfig, SitemapOrigin, TitleSource } from "./types.js";

/** Read the real version rather than a constant that drifts from the package. */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    return JSON.parse(readFileSync(pkgUrl, "utf-8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = readVersion();

function printHelp() {
  console.log(`
  site-to-md v${VERSION}
  Make any website AI-agent-readable.

  Usage:
    site-to-md <url>              Crawl a website and generate markdown
    site-to-md <directory>        Process local HTML files
    site-to-md --help             Show this help

  Options:
    --out <dir>         Output directory (default: ./<hostname>-md)
    --base-url <url>    Origin the output will be served from; makes every
                        emitted URL absolute (default: the crawl origin)
    --title <name>      Site title for llms.txt header
    --desc <text>       Site description for llms.txt
    --include <glob>    Include only matching paths (repeatable)
    --exclude <glob>    Exclude matching paths (repeatable)
    --no-ctx            Skip generating llms-ctx.txt
    --no-sitemap        Don't use sitemap.xml for crawling
    --sitemap-origin <mode>
                        Sitemaps listing another origin: rewrite (default),
                        strict (refuse), follow (pre-0.2 behaviour)
    --max-depth <n>     Max crawl depth (default: 3)
    --concurrency <n>   Parallel requests (default: 5)
    --strip <selector>  CSS selectors to strip from extracted content
                        (repeatable)
    --strip-source      Strip before extraction instead of after; can change
                        which node is treated as the article (pre-0.2)
    --title-source <s>  auto (default), og, or title
    --serve <command>   Start a server, crawl it, then stop it
    --report            Audit what an agent can read; writes nothing
    --strict            Exit non-zero if anything is flagged (for CI)
    --config <path>     Path to config file
    --version           Show version
    --help              Show this help

  Examples:
    npx site-to-md https://docs.mysite.com
    npx site-to-md ./dist --out ./public
    npx site-to-md --serve "npm start" --out ./public
    npx site-to-md https://mysite.com --include "/docs/**" --include "/blog/**"
    npx site-to-md ./out --base-url https://mysite.com --strict
    npx site-to-md https://mysite.com --report
  `);
}

function parseArgs(argv: string[]): { target?: string; flags: Record<string, string | string[] | boolean> } {
  const flags: Record<string, string | string[] | boolean> = {};
  let target: string | undefined;

  const valueFlags: Record<string, string> = {
    "--out": "out",
    "--base-url": "baseUrl",
    "--title": "title",
    "--desc": "desc",
    "--max-depth": "maxDepth",
    "--concurrency": "concurrency",
    "--config": "config",
    "--sitemap-origin": "sitemapOrigin",
    "--title-source": "titleSource",
    "--serve": "serve",
  };

  const listFlags: Record<string, string> = {
    "--include": "include",
    "--exclude": "exclude",
    "--strip": "strip",
  };

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
    } else if (arg === "--strict") {
      flags.strict = true;
    } else if (arg === "--report") {
      flags.report = true;
    } else if (arg === "--strip-source") {
      flags.stripSource = true;
    } else if (valueFlags[arg] && argv[i + 1]) {
      flags[valueFlags[arg]] = argv[++i];
    } else if (listFlags[arg] && argv[i + 1]) {
      const key = listFlags[arg];
      if (!Array.isArray(flags[key])) flags[key] = [];
      (flags[key] as string[]).push(argv[++i]);
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

  // --help must work even when a config file is broken, so it is handled
  // before the config is loaded.
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  const fileConfig = await loadConfigFile(flags.config as string | undefined);

  // A serve command may come from either place; --serve wins.
  const serveCommand = (flags.serve as string | undefined) ?? fileConfig.serve;

  // --serve supplies the target itself.
  if (!target && !serveCommand) {
    printHelp();
    process.exit(1);
  }

  const chalk = (await import("chalk")).default;
  const { default: ora } = await import("ora");

  let server: ServeHandle | undefined;
  let effectiveTarget = target;

  console.log("");
  console.log(chalk.bold("  🤖 site-to-md"));

  if (serveCommand) {
    const bootSpinner = ora({ text: `Starting "${serveCommand}"...`, indent: 2 }).start();
    try {
      server = await startServer(serveCommand);
      effectiveTarget = server.url;
      bootSpinner.succeed(chalk.green(`Server ready on ${server.url}`));
    } catch (err) {
      bootSpinner.fail(chalk.red("Server failed to start"));
      console.error(chalk.red(`\n  ${err instanceof Error ? err.message : err}\n`));
      process.exit(1);
    }
  }

  if (!effectiveTarget) {
    printHelp();
    process.exit(1);
  }

  const isUrl = effectiveTarget.startsWith("http://") || effectiveTarget.startsWith("https://");
  const isDir = !isUrl && existsSync(effectiveTarget);

  if (!isUrl && !isDir) {
    console.error(`Error: "${effectiveTarget}" is not a valid URL or directory.`);
    await server?.stop();
    process.exit(1);
  }

  // Merge config: file < CLI flags
  const config: AgentReadyConfig = {
    ...fileConfig,
    ...(isUrl ? { url: effectiveTarget } : { dir: resolve(effectiveTarget) }),
    ...(flags.out ? { outDir: flags.out as string } : {}),
    ...(flags.baseUrl ? { baseUrl: flags.baseUrl as string } : {}),
    ...(flags.title ? { title: flags.title as string } : {}),
    ...(flags.desc ? { description: flags.desc as string } : {}),
    ...(flags.noCtx ? { llmsCtx: false } : {}),
    ...(flags.noSitemap ? { sitemap: false } : {}),
    ...(flags.sitemapOrigin ? { sitemapOrigin: flags.sitemapOrigin as SitemapOrigin } : {}),
    ...(flags.titleSource ? { titleSource: flags.titleSource as TitleSource } : {}),
    ...(flags.maxDepth ? { maxDepth: parseInt(flags.maxDepth as string, 10) } : {}),
    ...(flags.concurrency ? { concurrency: parseInt(flags.concurrency as string, 10) } : {}),
    ...(Array.isArray(flags.include) ? { include: flags.include as string[] } : {}),
    ...(Array.isArray(flags.exclude) ? { exclude: flags.exclude as string[] } : {}),
    ...(Array.isArray(flags.strip) ? { stripSelectors: flags.strip as string[] } : {}),
    ...(flags.stripSource ? { stripSource: true } : {}),
    ...(flags.strict ? { strict: true } : {}),
    ...(flags.report ? { report: true } : {}),
  };

  const label = isUrl ? effectiveTarget : resolve(effectiveTarget);
  const isReport = config.report === true;

  console.log(chalk.gray(`  ${isReport ? "Auditing" : "Making"} ${label}${isReport ? "" : " agent-readable"}...\n`));

  const spinner = ora({
    text: isUrl ? "Crawling site..." : "Reading HTML files...",
    indent: 2,
  }).start();

  try {
    const startTime = Date.now();
    const result = await agentReady(config);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const diagnostics = new Diagnostics();
    for (const d of result.diagnostics) diagnostics.add(d);
    const problems = diagnostics.problems;

    if (isReport) {
      spinner.stop();
      diagnostics.add({
        level: "ok",
        code: "extracted",
        message: `${result.pages.length} page${result.pages.length !== 1 ? "s" : ""} extracted cleanly`,
      });
      console.log(renderReport(label, diagnostics));
    } else {
      spinner.succeed(chalk.green(`Done in ${elapsed}s`));
      console.log("");
      console.log(chalk.bold("  Output:"));
      console.log(chalk.gray(`  📂 ${result.outputDir}`));
      console.log(chalk.gray(`  📄 llms.txt`));
      if (result.llmsCtx) console.log(chalk.gray(`  📄 llms-ctx.txt`));
      console.log(chalk.gray(`  📝 ${result.pages.length} page${result.pages.length !== 1 ? "s" : ""} converted to markdown`));
      console.log("");

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

      // Silent content loss is the failure mode this tool has to defend
      // against, so findings go to stderr even on a successful run.
      if (problems.length > 0) {
        for (const line of renderWarnings(diagnostics)) {
          console.error(chalk.yellow(`  ${line}`));
        }
        console.error("");
      }
    }

    await server?.stop();

    if (config.strict && problems.length > 0) {
      console.error(
        chalk.red(`  --strict: ${problems.length} finding${problems.length !== 1 ? "s" : ""}, failing.\n`)
      );
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    spinner.fail(chalk.red("Failed"));
    if (err instanceof ForeignSitemapError) {
      console.error(chalk.red(`\n  ${err.message}\n`));
    } else {
      console.error(chalk.red(`\n  ${err instanceof Error ? err.message : err}\n`));
    }
    await server?.stop();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
