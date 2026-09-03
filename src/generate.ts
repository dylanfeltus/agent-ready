import { matchesAnyGlob } from "./glob.js";
import type {
  AgentReadyConfig,
  ExternalEntry,
  GuidanceSection,
  PageResult,
  SectionSpec,
} from "./types.js";

/**
 * The mirror path for a page: the page's own URL with `.md` appended.
 *
 * The extension comes from the source URL, not a fixed suffix — a page served
 * at /docs/products mirrors to /docs/products.md, while one served at
 * /guide.html mirrors to /guide.html.md. Always appending `.html.md` gave
 * extensionless URLs — the common case on modern frameworks — a link that
 * does not resolve.
 */
export function mirrorPath(page: PageResult): string {
  let pathname = page.path;
  try {
    // page.url is absolute for a crawl and site-relative for a directory
    // build; either way it still carries the original extension.
    pathname = new URL(page.url, "http://localhost").pathname;
  } catch { /* fall back to the normalised path */ }

  if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  if (!pathname || pathname === "/index") pathname = "/index";

  return `${pathname}.md`;
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

/**
 * The published address of a crawled page.
 *
 * Built from the page's real URL rather than its mirror path, because the path
 * has any extension stripped — a page served at /guide.html would otherwise be
 * cited as /guide, which may not exist.
 */
export function sourceUrl(page: PageResult, baseUrl?: string): string {
  if (!baseUrl) return page.url;
  try {
    const base = new URL(baseUrl);
    // page.url is absolute for a crawl and site-relative for a directory build.
    const parsed = new URL(page.url, base);
    return new URL(parsed.pathname + parsed.search + parsed.hash, base).href;
  } catch {
    return page.url;
  }
}

function isGuidance(spec: SectionSpec): spec is GuidanceSection {
  return !Array.isArray(spec) && typeof spec === "object" && Array.isArray(spec.bullets);
}

function isExternalEntries(spec: SectionSpec): spec is ExternalEntry[] {
  return Array.isArray(spec) && typeof spec[0] === "object";
}

function globsOf(spec: SectionSpec): string[] {
  if (typeof spec === "string") return [spec];
  if (isGuidance(spec) || isExternalEntries(spec)) return [];
  return spec as string[];
}

/**
 * Turn a URL slug into a section heading.
 *
 * A path segment is a slug, not a title: "revenue-recognition" should read as
 * "Revenue Recognition", the way a hand-written llms.txt words it, rather than
 * leaking the hyphen into the document.
 */
function headingFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Pages that matched none of the configured section globs. */
export function unsectionedPages(
  pages: PageResult[],
  config: AgentReadyConfig
): PageResult[] {
  if (!config.sections) return [];
  const globs = Object.values(config.sections).flatMap(globsOf);
  if (globs.length === 0) return [];
  return pages.filter((page) => !matchesAnyGlob(page.path, globs));
}

/** Assign pages to sections based on config or auto-detect from URL structure */
function assignSections(pages: PageResult[], config: AgentReadyConfig): PageResult[] {
  if (config.sections) {
    const entries = Object.entries(config.sections);
    return pages.map((page) => {
      for (const [name, spec] of entries) {
        if (matchesAnyGlob(page.path, globsOf(spec))) {
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
      return { ...page, section: headingFromSlug(segments[0]) };
    }
    return page;
  });
}

/** Collapse to one line — a stray newline would end the list item early. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Escape brackets so a title like "Guide [v2]" cannot break the link. */
function linkText(text: string): string {
  return oneLine(text).replace(/([[\]])/g, "\\$1");
}

function renderPageLine(
  page: PageResult,
  baseUrl?: string,
  summary?: string
): string {
  const href = toEmittedUrl(mirrorPath(page), baseUrl);
  const text = page.description ? oneLine(page.description) : "";
  // The site summary is already the line above the list; repeating it verbatim
  // on the page it came from spends tokens saying nothing new.
  const desc = text && text !== summary ? `: ${text}` : "";
  return `- [${linkText(page.title)}](${href})${desc}\n`;
}

function renderEntryLine(entry: ExternalEntry, baseUrl?: string): string {
  // A site-relative entry (e.g. /openapi.json) is an emitted URL like any
  // other and must obey baseUrl; an absolute one passes through untouched.
  const href = toEmittedUrl(entry.url, baseUrl);
  const desc = entry.description ? `: ${oneLine(entry.description)}` : "";
  return `- [${linkText(entry.title)}](${href})${desc}\n`;
}

/** Generate /llms.txt content per llmstxt.org spec */
export function generateLlmsTxt(pages: PageResult[], config: AgentReadyConfig): string {
  const title = config.title || "Website";
  const desc = config.description || pages[0]?.description || "Documentation and content";
  const baseUrl = config.baseUrl;
  const summary = oneLine(desc);

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
    output += renderPageLine(page, baseUrl, summary);
  }

  if (unsectioned.length > 0 && sections.size > 0) output += "\n";

  // Sections declared in config keep their declared order, and a section of
  // literal entries is emitted even though no crawled page matched it.
  const declared = config.sections ? Object.keys(config.sections) : [];
  const ordered = [
    ...declared,
    ...[...sections.keys()].filter((name) => !declared.includes(name)),
  ];

  // "Optional" has a defined meaning — content an agent may skip when short on
  // context — so it belongs last however it was declared.
  const isOptional = (name: string) => name.toLowerCase() === "optional";
  ordered.sort((a, b) => Number(isOptional(a)) - Number(isOptional(b)));

  for (const name of ordered) {
    const spec = config.sections?.[name];
    const sectionPages = sections.get(name) || [];
    const external = spec && isExternalEntries(spec) ? spec : [];
    const guidance = spec && isGuidance(spec) ? spec.bullets : [];

    if (sectionPages.length === 0 && external.length === 0 && guidance.length === 0) {
      continue;
    }

    output += `## ${name}\n\n`;
    // Guidance is prose about the site, so it leads the section.
    for (const bullet of guidance) output += `- ${oneLine(bullet)}\n`;
    for (const page of sectionPages) output += renderPageLine(page, baseUrl, summary);
    for (const entry of external) output += renderEntryLine(entry, baseUrl);
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
    const source = sourceUrl(page, baseUrl);
    output += `## ${page.title}\n\n`;
    output += `Source: ${source}\n\n`;
    output += page.markdown + "\n\n";
    output += `---\n\n`;
  }

  return output.trimEnd() + "\n";
}
