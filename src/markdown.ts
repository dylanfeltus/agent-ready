import TurndownService from "turndown";

/**
 * Markdown conversion.
 *
 * Two pieces here exist to stop silent meaning-loss on comparison content
 * (pricing tables, feature matrices):
 *
 * - Turndown ships no table rule at all — TABLE/TR/TD are only known to it as
 *   block elements — so a perfectly preserved HTML table is otherwise
 *   flattened into a vertical run of text with every row and column boundary
 *   gone.
 * - Cells whose only content is an icon (a tick/cross <svg> with no text)
 *   otherwise emit nothing, which erases the meaning of a row while leaving
 *   its label intact. That is what makes a Free plan appear to include the
 *   features it does not.
 *
 * Icon resolution has to happen as a DOM pre-pass rather than a Turndown rule:
 * Turndown short-circuits "blank" nodes to its blankRule before custom rules
 * are consulted, and an icon with no text is blank by that definition.
 */

/** Markers used for resolved icon-only content. */
export const YES = "✓";
export const NO = "—";

/** Counters for content the converter could not represent faithfully. */
export interface MarkdownLoss {
  /** Icon-only elements that could not be resolved to a yes/no marker. */
  lostIcons: number;
  /** Tables emitted as flattened text rather than a markdown table. */
  degradedTables: number;
}

export function emptyLoss(): MarkdownLoss {
  return { lostIcons: 0, degradedTables: 0 };
}

const YES_PATTERN = /check|tick|\byes\b|included|success|available|enabled|circle-plus/i;
const NO_PATTERN = /cross|times|xmark|x-circle|excluded|minus|unavailable|disabled|\bnot\b|\bno\b/i;

/** Elements conventionally used as icons rather than as text. */
const ICON_TAGS = new Set(["SVG", "I", "SPAN", "IMG"]);

function attr(el: Element, name: string): string {
  return el.getAttribute(name)?.trim() || "";
}

/**
 * Resolve an icon-only element to a yes/no marker.
 *
 * Accessibility metadata is authoritative and checked first; class names are a
 * heuristic fallback. Returns null when the element carries no usable signal,
 * so the caller can count it as lost rather than guessing.
 */
export function resolveIcon(el: Element): string | null {
  const labels: string[] = [];

  if (el.nodeName.toUpperCase() === "IMG") {
    // A non-empty alt is real content and already round-trips as an image;
    // only altless images are candidates for marker resolution. Reading alt
    // here would misread e.g. alt="Success stories" as a tick.
    if (attr(el, "alt")) return null;
    labels.push(attr(el, "src"), attr(el, "data-icon"), attr(el, "class"));
  } else {
    labels.push(attr(el, "aria-label"), attr(el, "title"), attr(el, "data-icon"));

    // <svg><title>Included</title></svg> and <svg><use href="#check"/></svg>
    const titleEl = el.querySelector("title");
    if (titleEl?.textContent) labels.push(titleEl.textContent.trim());
    const use = el.querySelector("use");
    if (use) labels.push(attr(use, "href") || attr(use, "xlink:href"));

    // Class names are a weaker signal, so they go last.
    labels.push(attr(el, "class"), attr(el, "data-testid"));
  }

  for (const label of labels) {
    if (!label) continue;
    // "no" is checked first: a class like "icon-check icon-check--excluded"
    // should read as excluded, not included.
    if (NO_PATTERN.test(label)) return NO;
    if (YES_PATTERN.test(label)) return YES;
  }

  return null;
}

/**
 * Text an element actually renders.
 *
 * Inside SVG, only <text>/<tspan> is drawn — <title> and <desc> are metadata
 * providing the accessible name, so an <svg><title>Included</title></svg> is
 * still a bare icon and must be treated as one.
 */
function visibleText(el: Element): string {
  if (el.nodeName.toUpperCase() !== "SVG") return el.textContent?.trim() || "";
  return Array.from(el.querySelectorAll("text, tspan"))
    .map((t) => t.textContent?.trim() || "")
    .join("")
    .trim();
}

/**
 * True when an element is an icon carrying no text of its own.
 *
 * nodeName is uppercased before comparison: SVG elements live in the SVG
 * namespace and keep their lowercase name, unlike HTML elements.
 */
function isIconOnly(el: Element): boolean {
  if (!ICON_TAGS.has(el.nodeName.toUpperCase())) return false;
  // An image with alt text carries its meaning in that text and round-trips as
  // markdown. It is content, not an icon — counting it as an unresolved icon
  // would fail --strict on any ordinary page that contains a picture.
  if (el.nodeName.toUpperCase() === "IMG" && attr(el, "alt")) return false;
  return !visibleText(el);
}

/**
 * Replace icon-only elements with a resolved ✓ / — text node, in place.
 *
 * Runs on the extracted article DOM before conversion. Returns the number of
 * icons that carried no resolvable signal, so a caller can report the loss.
 */
export function resolveIcons(root: Element | Document): number {
  let lost = 0;
  const candidates = Array.from(root.querySelectorAll(
    "svg, i, span, img"
  )) as Element[];

  for (const el of candidates) {
    // An icon nested inside another icon-only element was detached when that
    // one was replaced; skip it rather than counting the same icon twice.
    if (!root.contains(el)) continue;
    if (!isIconOnly(el)) continue;

    const marker = resolveIcon(el);
    if (marker) {
      const doc = el.ownerDocument!;
      // Trailing space keeps "✓ Custom domain" readable when the icon
      // immediately precedes its label with no whitespace between.
      el.replaceWith(doc.createTextNode(`${marker} `));
      continue;
    }

    // Decoration that is deliberately hidden from assistive tech is not a loss.
    if (attr(el, "aria-hidden") === "true") continue;
    // A span with no attributes at all is a layout wrapper, not an icon.
    if (el.nodeName.toUpperCase() === "SPAN" && el.attributes.length === 0) continue;
    // An altless img with no signal was already dropped by img-cleanup.
    lost++;
  }

  return lost;
}

/** Collapse cell content onto one line and escape markdown table delimiters. */
function cellText(md: string): string {
  return md
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a Turndown instance plus the loss counters its rules write into.
 * Per-instance counters keep the numbers scoped to one page.
 */
export function createTurndown(): { service: TurndownService; loss: MarkdownLoss } {
  const loss = emptyLoss();

  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  // Better code block handling
  service.addRule("pre-code", {
    filter: (node) => node.nodeName === "PRE" && !!node.querySelector("code"),
    replacement: (content, node) => {
      const code = (node as HTMLElement).querySelector("code");
      if (!code) return content;
      const lang = code.className?.match(/language-(\w+)/)?.[1] || "";
      return `\n\`\`\`${lang}\n${code.textContent?.trim()}\n\`\`\`\n`;
    },
  });

  // Strip images with no alt text
  service.addRule("img-cleanup", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node as HTMLElement).getAttribute("alt");
      const src = (node as HTMLElement).getAttribute("src");
      if (!alt && !src) return "";
      return alt ? `![${alt}](${src || ""})` : "";
    },
  });

  // Emit GFM tables. Turndown has no table support of its own.
  service.addRule("table", {
    filter: (node) => node.nodeName === "TABLE",
    replacement: (content, node) => {
      const rendered = renderTable(node as unknown as Element);
      if (rendered) return `\n\n${rendered}\n\n`;
      // Fall back to the flattened text rather than mangling the columns.
      loss.degradedTables++;
      return content;
    },
  });

  return { service, loss };
}

/** A Turndown instance used only for cell contents — no table rule, so a
 *  nested render can never recurse back into table handling. */
const cellRenderer = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/**
 * Render a <table> as a GFM table, or null when its shape cannot be
 * represented (merged cells, nesting) and flattening is the honest fallback.
 */
function renderTable(table: Element): string | null {
  if (table.querySelector("table")) return null;

  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return null;

  const grid: string[][] = [];
  // Tracks which grid rows are entirely <th>, to tell a column-header row from
  // row labels. A matrix like `<tr><th>Feature</th><td>Yes</td></tr>` uses <th>
  // for row labels; promoting that to the header would delete a whole row of
  // data and relabel the columns with it.
  const allHeaderCells: boolean[] = [];

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll("th, td"));
    if (cells.length === 0) continue;
    for (const cell of cells) {
      const span = cell.getAttribute("colspan") || cell.getAttribute("rowspan");
      // A merged cell means the visual grid is not rectangular; markdown
      // cannot express it, so degrade rather than silently misalign columns.
      if (span && parseInt(span, 10) > 1) return null;
    }
    allHeaderCells.push(cells.every((c) => c.nodeName.toUpperCase() === "TH"));
    grid.push(cells.map((c) => cellText(cellRenderer.turndown(c.innerHTML))));
  }

  if (grid.length === 0) return null;

  const width = Math.max(...grid.map((r) => r.length));
  if (width === 0) return null;
  for (const row of grid) {
    while (row.length < width) row.push("");
  }

  // GFM requires a header row. Use the table's own if it genuinely leads with
  // one, otherwise synthesize an empty one so the body survives intact.
  const hasThead = !!table.querySelector("thead th, thead td");
  const hasHeader = hasThead || allHeaderCells[0] === true;
  const header = hasHeader ? grid.shift()! : new Array(width).fill("");
  if (grid.length === 0) return null;

  return [
    `| ${header.join(" | ")} |`,
    `| ${new Array(width).fill("---").join(" | ")} |`,
    ...grid.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}
