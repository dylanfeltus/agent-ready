/**
 * Diagnostics — the defence against silent content loss.
 *
 * Every check records a structured Diagnostic rather than printing. Warnings
 * on stderr, `--strict`'s non-zero exit, and `--report`'s audit are three
 * renderings of this one collection.
 */

export type DiagnosticLevel = "error" | "warn" | "info" | "ok";

export interface Diagnostic {
  level: DiagnosticLevel;
  /** Stable machine-readable code, e.g. "content-loss", "duplicate-title". */
  code: string;
  /** Page path this concerns, when page-scoped. */
  page?: string;
  message: string;
  detail?: string;
}

export class Diagnostics {
  private items: Diagnostic[] = [];

  add(d: Diagnostic): void {
    this.items.push(d);
  }

  get all(): Diagnostic[] {
    return this.items;
  }

  /** Findings that represent something wrong, for --strict. */
  get problems(): Diagnostic[] {
    return this.items.filter((d) => d.level === "warn" || d.level === "error");
  }

  byCode(code: string): Diagnostic[] {
    return this.items.filter((d) => d.code === code);
  }
}

/** Structural census of a page, used to compare input against output. */
export interface ContentMetrics {
  textLength: number;
  headings: number;
  tables: number;
  lists: number;
  links: number;
}

/**
 * Measure the source DOM.
 *
 * Call this *after* the default boilerplate strip, so the comparison isolates
 * what extraction lost from real content rather than counting nav and footer
 * as loss.
 */
export function measureDom(root: Element | Document): ContentMetrics {
  const q = (sel: string) => root.querySelectorAll(sel).length;
  const text = ("textContent" in root ? root.textContent : "") || "";
  return {
    textLength: text.replace(/\s+/g, " ").trim().length,
    headings: q("h1, h2, h3, h4, h5, h6"),
    tables: q("table"),
    lists: q("ul, ol"),
    links: q("a[href]"),
  };
}

/** Measure generated markdown. Approximate by design — we detect collapse. */
export function measureMarkdown(md: string): ContentMetrics {
  const lines = md.split(/\r?\n/);
  const plain = md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/[|`*_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // A GFM table is identified by its delimiter row.
  const tables = lines.filter((l) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l)).length;

  let lists = 0;
  let inList = false;
  for (const line of lines) {
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      if (!inList) lists++;
      inList = true;
      continue;
    }
    // Blank lines and indented continuations stay inside the list; only real
    // prose ends it. Splitting on blanks would count one loose list as many.
    if (line.trim() === "" || /^\s+/.test(line)) continue;
    inList = false;
  }

  return {
    textLength: plain.length,
    headings: lines.filter((l) => /^#{1,6}\s+/.test(l)).length,
    tables,
    lists,
    links: (md.match(/\[[^\]]*\]\([^)]*\)/g) || []).length,
  };
}

/** Below this share of source text, a page is considered collapsed. */
const TEXT_RATIO_THRESHOLD = 0.5;
/** Pages shorter than this are too small for the ratio to mean anything. */
const MIN_SOURCE_TEXT = 200;

/**
 * Compare a page's input to its output and record any collapse.
 *
 * This is the generic guard: it catches the three known loss paths and,
 * more importantly, the next one nobody has found yet.
 */
export function checkContentLoss(
  page: string,
  source: ContentMetrics,
  output: ContentMetrics,
  diagnostics: Diagnostics
): void {
  const losses: string[] = [];

  const ratio = source.textLength > 0 ? output.textLength / source.textLength : 1;
  const collapsed = source.textLength >= MIN_SOURCE_TEXT && ratio < TEXT_RATIO_THRESHOLD;

  if (source.headings - output.headings >= 2) {
    losses.push(`${source.headings - output.headings} headings lost`);
  }
  if (output.tables < source.tables) {
    losses.push(`${source.tables - output.tables} table${source.tables - output.tables !== 1 ? "s" : ""} lost`);
  }
  if (source.lists - output.lists >= 2) {
    losses.push(`${source.lists - output.lists} lists lost`);
  }

  if (!collapsed && losses.length === 0) return;

  const pct = Math.round(ratio * 100);
  const head = collapsed
    ? `output is ${pct}% of source text (${source.textLength} → ${output.textLength} chars)`
    : `output is ${pct}% of source text`;

  diagnostics.add({
    level: "warn",
    code: "content-loss",
    page,
    message: `${page} — ${[head, ...losses].join("; ")}`,
  });
}

/** Record icons and tables the markdown converter could not represent. */
export function checkConversionLoss(
  page: string,
  lostIcons: number,
  degradedTables: number,
  diagnostics: Diagnostics
): void {
  if (lostIcons > 0) {
    diagnostics.add({
      level: "warn",
      code: "unresolved-icons",
      page,
      message: `${page} — ${lostIcons} icon${lostIcons !== 1 ? "s" : ""} could not be read as included/excluded`,
      detail: "Give each icon an aria-label, title, or alt so its meaning survives conversion.",
    });
  }
  if (degradedTables > 0) {
    diagnostics.add({
      level: "warn",
      code: "degraded-table",
      page,
      message: `${page} — ${degradedTables} table${degradedTables !== 1 ? "s" : ""} flattened (merged or nested cells)`,
      detail: "Markdown cannot express merged cells; the text is preserved but the grid is not.",
    });
  }
}

/**
 * Warn when pages share a title.
 *
 * Readability prefers og:title over <title> (Readability.js:1514-1524), and a
 * single site-wide og:title in a root layout therefore collapses every entry
 * in llms.txt to the same name — a useless index built from correct data.
 */
export function checkDuplicateTitles(
  pages: { path: string; title: string; fallbackTitle?: string }[],
  diagnostics: Diagnostics
): void {
  const byTitle = new Map<string, typeof pages>();
  for (const page of pages) {
    if (!byTitle.has(page.title)) byTitle.set(page.title, []);
    byTitle.get(page.title)!.push(page);
  }

  for (const [title, group] of byTitle) {
    if (group.length < 2) continue;

    const fallbacks = group
      .map((p) => p.fallbackTitle)
      .filter((t): t is string => !!t && t !== title);
    const distinct = [...new Set(fallbacks)];

    diagnostics.add({
      level: "warn",
      code: "duplicate-title",
      message: `${group.length} pages share the title "${title}"`,
      detail: distinct.length >= 2
        ? `They likely lack a per-page og:title; falling back to <title> would give: ${distinct
            .slice(0, 3)
            .map((t) => `"${t}"`)
            .join(", ")}${distinct.length > 3 ? ", …" : ""}. Re-run with --title-source title to use those.`
        : "Give each page its own og:title, or re-run with --title-source title.",
    });
  }
}

const ICONS: Record<DiagnosticLevel, string> = {
  error: "✗",
  warn: "⚠",
  info: "•",
  ok: "✓",
};

/** Render warnings for the normal run — concise, one line each. */
export function renderWarnings(diagnostics: Diagnostics): string[] {
  return diagnostics.problems.map((d) => `${ICONS[d.level]} ${d.message}`);
}

/**
 * Render the audit (`--report`).
 *
 * Deliberately lists findings without a headline score: any single number
 * would be invented, and the findings are what a reader can act on.
 */
export function renderReport(target: string, diagnostics: Diagnostics): string {
  const lines: string[] = ["", `  ${target}`, ""];

  const order: DiagnosticLevel[] = ["error", "warn", "info", "ok"];
  const items = [...diagnostics.all].sort(
    (a, b) => order.indexOf(a.level) - order.indexOf(b.level)
  );

  if (items.length === 0) {
    lines.push("  ✓ nothing to report", "");
    return lines.join("\n");
  }

  for (const d of items) {
    lines.push(`  ${ICONS[d.level]} ${d.message}`);
    if (d.detail) lines.push(`      ${d.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}
