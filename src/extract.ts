import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { createTurndown, resolveIcons } from "./markdown.js";
import { measureDom, measureMarkdown, type ContentMetrics } from "./diagnostics.js";
import type { AgentReadyConfig, PageResult } from "./types.js";

/**
 * Boilerplate stripped before Readability runs.
 *
 * These are structural chrome, safe to remove from the source DOM. User
 * selectors are deliberately *not* applied here — see extractPage.
 */
const DEFAULT_STRIP = [
  "nav", "footer", "header",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  ".cookie-banner", ".cookie-consent", "#cookie-banner",
  ".ad", ".ads", ".advertisement",
  "script", "style", "noscript", "iframe",
  ".sidebar", "aside",
];

/**
 * Invisible marker used to carry "the user wants this gone" through
 * Readability. Readability rewrites tags — a <div class="promo"> comes out as
 * a <p> with no class — so a CSS selector cannot be re-applied to its output.
 * Text content, however, survives intact.
 */
const STRIP_MARK = "\u2062\u2062STM\u2062\u2062";

function removeAll(root: Element | Document, selectors: string[]): number {
  let removed = 0;
  for (const sel of selectors) {
    try {
      root.querySelectorAll(sel).forEach((el) => {
        el.remove();
        removed++;
      });
    } catch { /* invalid selector */ }
  }
  return removed;
}

/** Everything extraction learned about a page, beyond the page itself. */
export interface ExtractionReport {
  source: ContentMetrics;
  output: ContentMetrics;
  lostIcons: number;
  degradedTables: number;
}

export interface ExtractOutcome {
  page: PageResult;
  report: ExtractionReport;
}

/** Extract readable content from HTML and convert to markdown */
export function extractPage(
  url: string,
  html: string,
  config: AgentReadyConfig
): ExtractOutcome | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // The <title> element, read before Readability consumes the document.
  // Readability prefers og:title and only falls back to <title> when no
  // metadata title exists at all (Readability.js:1514-1524), so a site-wide
  // og:title collapses every page to one name. Keep this to offer as a
  // fallback and to power --title-source.
  const documentTitle = doc.querySelector("title")?.textContent?.trim() || "";
  const metaDesc = doc
    .querySelector('meta[name="description"]')
    ?.getAttribute("content")
    ?.trim() || undefined;

  removeAll(doc, DEFAULT_STRIP);

  const userSelectors = config.stripSelectors || [];

  // Historic behaviour: user selectors removed from the source DOM. This can
  // change which node Readability scores as the article root, so one selector
  // matching a small block inside the content can delete the whole section
  // around it. Opt-in only.
  if (config.stripSource && userSelectors.length) {
    removeAll(doc, userSelectors);
  }

  // Measured after boilerplate removal, and with user-stripped content already
  // discounted, so the guard compares extraction against the content the user
  // actually asked to keep rather than flagging their own strip as loss.
  const measureDoc = doc.cloneNode(true) as Document;
  if (!config.stripSource && userSelectors.length) {
    removeAll(measureDoc, userSelectors);
  }
  const source = measureDom(measureDoc.body || measureDoc.documentElement);

  // Mark rather than remove: removing perturbs Readability's scoring, which is
  // what let a single selector delete the section around it.
  let marked = 0;
  if (!config.stripSource && userSelectors.length) {
    for (const sel of userSelectors) {
      try {
        doc.querySelectorAll(sel).forEach((el) => {
          el.insertBefore(doc.createTextNode(STRIP_MARK), el.firstChild);
          marked++;
        });
      } catch { /* invalid selector */ }
    }
  }

  // keepClasses is required for user strip selectors to work post-extraction:
  // Readability strips class and id attributes from its output by default, so
  // a selector like ".promo" would have nothing left to match.
  const article = new Readability(doc, {
    charThreshold: 50,
    keepClasses: true,
  }).parse();
  if (!article || !article.textContent?.trim()) return null;

  // Re-parse the extracted article so user strip selectors, icon resolution
  // and measurement all operate on the same DOM.
  const articleDom = new JSDOM(`<body>${article.content}</body>`, { url });
  const articleBody = articleDom.window.document.body;

  // Drop the marked blocks now that Readability has chosen the article root.
  // Their effect is local: nothing outside the matched element is touched.
  if (marked > 0) removeMarked(articleBody);

  // Resolve tick/cross icons to ✓ / — before conversion. Turndown drops
  // text-free nodes via its blankRule before custom rules run, so this cannot
  // be a Turndown rule.
  const lostIcons = resolveIcons(articleBody);

  const { service, loss } = createTurndown();
  const markdown = service.turndown(articleBody.innerHTML).trim();
  if (!markdown || markdown.length < 20) return null;

  const output = measureMarkdown(markdown);

  // Build path from URL
  const parsed = new URL(url);
  let path = parsed.pathname;
  if (path === "/") path = "/index";
  if (path.endsWith("/")) path = path.slice(0, -1);
  // Strip .html/.htm extension — we'll add .html.md in output
  path = path.replace(/\.html?$/, "");

  const readabilityTitle = article.title?.trim() || "";
  const title = chooseTitle(readabilityTitle, documentTitle, config, parsed.pathname);

  return {
    page: {
      url,
      path,
      title,
      markdown: `# ${title}\n\n${markdown}`,
      description: metaDesc || article.excerpt?.trim() || undefined,
      fallbackTitle: documentTitle || undefined,
    },
    report: {
      source,
      output,
      lostIcons: lostIcons + loss.lostIcons,
      degradedTables: loss.degradedTables,
    },
  };
}

/**
 * Remove every element carrying a strip mark, then clear stray marks.
 *
 * The mark sits as the first text node of a matched element; removing that
 * node's parent removes exactly what the selector matched, whatever tag
 * Readability rewrote it into.
 */
function removeMarked(root: Element): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const marks: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue?.includes(STRIP_MARK)) marks.push(node as Text);
    node = walker.nextNode();
  }

  for (const mark of marks) {
    const parent = mark.parentElement;
    if (parent && parent !== root) parent.remove();
    else mark.nodeValue = (mark.nodeValue || "").split(STRIP_MARK).join("");
  }

  // Any mark that outlived its element (Readability may hoist text) is
  // invisible but would still reach the markdown.
  if (root.innerHTML.includes(STRIP_MARK)) {
    root.innerHTML = root.innerHTML.split(STRIP_MARK).join("");
  }
}

/**
 * Pick a page title.
 *
 * "auto" keeps Readability's choice here; index.ts revisits it across all
 * pages, where an og:title shared by every page is actually detectable.
 */
function chooseTitle(
  readabilityTitle: string,
  documentTitle: string,
  config: AgentReadyConfig,
  pathname: string
): string {
  const source = config.titleSource || "auto";
  if (source === "title" && documentTitle) return documentTitle;
  return readabilityTitle || documentTitle || pathname;
}

/** Extract from a local HTML file */
export function extractLocalFile(
  filePath: string,
  html: string,
  basePath: string,
  config: AgentReadyConfig
): ExtractOutcome | null {
  // Create a fake URL for JSDOM
  const relativePath = filePath.replace(basePath, "").replace(/\\/g, "/");
  const fakeUrl = `http://localhost${relativePath}`;

  const outcome = extractPage(fakeUrl, html, config);
  if (!outcome) return null;

  // Fix the path to be relative
  outcome.page.path = relativePath.replace(/\.html?$/, "").replace(/\/index$/, "/");
  outcome.page.url = relativePath;

  return outcome;
}
