import type {
  AgentReadyConfig,
  ExternalEntry,
  PageResult,
  SectionSpec,
} from "./types.js";

/** The mirror path for a page, e.g. /pricing -> /pricing.html.md */
export function mirrorPath(page: PageResult): string {
  if (page.path === "/" || page.path === "/index") return "/index.html.md";
  return `${page.path}.html.md`;
}

/**
 * Make an emitted URL absolute against baseUrl.
 *
 * llms.txt is routinely fetched on its own, with no page to resolve relative
 * links against, and the crawl origin (localhost) is rarely the publish
 * origin. With no baseUrl set, paths stay site-relative as before.
 */
export function toEmittedUrl(pathOrUrl: string, baseUrl?: string): string {
  if (!baseUrl) return pathOrUrl;
  try {
    return new URL(pathOrUrl, baseUrl).href;
  } catch {
    return pathOrUrl;
  }
}

function isExternalEntries(spec: SectionSpec): spec is ExternalEntry[] {
  return Array.isArray(spec) && typeof spec[0] === "object";
}

function globsOf(spec: SectionSpec): string[] {
  if (typeof spec === "string") return [spec];
  if (isExternalEntries(spec)) return [];
  return spec as string[];
}

function matchesGlob(path: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$"
  );
  return regex.test(path);
}

/** Assign pages to sections based on config or auto-detect from URL structure */
function assignSections(pages: PageResult[], config: AgentReadyConfig): PageResult[] {
  if (config.sections) {
    const entries = Object.entries(config.sections);
    return pages.map((page) => {
      for (const [name, spec] of entries) {
        if (globsOf(spec).some((g) => matchesGlob(page.path, g))) {
          return { ...page, section: name };
        }
      }
      return page;
    });
  }

  // Auto-detect sections from first path segment
  return pages.map((page) => {
    const segments = page.path.split("/").filter(Boolean);
    if (segments.length >= 2) {
      const section = segments[0].charAt(0).toUpperCase() + segments[0].slice(1);
      return { ...page, section };
    }
    return page;
  });
}

function renderPageLine(page: PageResult, baseUrl?: string): string {
  const href = toEmittedUrl(mirrorPath(page), baseUrl);
  return `- [${page.title}](${href})${page.description ? `: ${page.description}` : ""}\n`;
}

function renderEntryLine(entry: ExternalEntry): string {
  return `- [${entry.title}](${entry.url})${entry.description ? `: ${entry.description}` : ""}\n`;
}

/** Generate /llms.txt content per llmstxt.org spec */
export function generateLlmsTxt(pages: PageResult[], config: AgentReadyConfig): string {
  const title = config.title || "Website";
  const desc = config.description || pages[0]?.description || "Documentation and content";
  const baseUrl = config.baseUrl;

  const pagesWithSections = assignSections(pages, config);

  let output = `# ${title}\n\n`;
  output += `> ${desc}\n\n`;

  if (config.notes?.length) {
    for (const note of config.notes) output += `${note}\n`;
    output += "\n";
  }

  // Group by section
  const sections = new Map<string, PageResult[]>();
  const unsectioned: PageResult[] = [];

  for (const page of pagesWithSections) {
    if (page.section) {
      if (!sections.has(page.section)) sections.set(page.section, []);
      sections.get(page.section)!.push(page);
    } else {
      unsectioned.push(page);
    }
  }

  // Write unsectioned pages first
  for (const page of unsectioned) {
    output += renderPageLine(page, baseUrl);
  }

  if (unsectioned.length > 0 && sections.size > 0) output += "\n";

  // Sections declared in config keep their declared order, and a section of
  // literal entries is emitted even though no crawled page matched it.
  const declared = config.sections ? Object.keys(config.sections) : [];
  const ordered = [
    ...declared,
    ...[...sections.keys()].filter((name) => !declared.includes(name)),
  ];

  for (const name of ordered) {
    const spec = config.sections?.[name];
    const sectionPages = sections.get(name) || [];
    const external = spec && isExternalEntries(spec) ? spec : [];

    if (sectionPages.length === 0 && external.length === 0) continue;

    output += `## ${name}\n\n`;
    for (const page of sectionPages) output += renderPageLine(page, baseUrl);
    for (const entry of external) output += renderEntryLine(entry);
    output += "\n";
  }

  return output.trimEnd() + "\n";
}

/** Generate /llms-ctx.txt — all content inline for single-prompt ingestion */
export function generateLlmsCtx(pages: PageResult[], config: AgentReadyConfig): string {
  const title = config.title || "Website";
  const desc = config.description || "Full content for AI agent consumption";
  const baseUrl = config.baseUrl;

  let output = `# ${title}\n\n`;
  output += `> ${desc}\n\n`;
  output += `---\n\n`;

  for (const page of pages) {
    // Prefer the published location over the crawl origin, which is often
    // localhost and meaningless to a reader of this file.
    const source = baseUrl ? toEmittedUrl(page.path, baseUrl) : page.url;
    output += `## ${page.title}\n\n`;
    output += `Source: ${source}\n\n`;
    output += page.markdown + "\n\n";
    output += `---\n\n`;
  }

  return output.trimEnd() + "\n";
}
