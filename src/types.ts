import type { Diagnostic } from "./diagnostics.js";

/** A link in llms.txt that is not a crawled page — a spec, an SDK, a repo. */
export interface ExternalEntry {
  title: string;
  url: string;
  description?: string;
}

/**
 * A section is either path globs matching crawled pages, or literal entries
 * pointing anywhere. The most valuable lines in an llms.txt are often not on
 * the crawled site at all.
 */
export type SectionSpec = string | string[] | ExternalEntry[];

/** How to pick each page's title. */
export type TitleSource = "auto" | "og" | "title";

/** What to do when a sitemap lists URLs on another origin. */
export type SitemapOrigin = "rewrite" | "strict" | "follow";

export interface AgentReadyConfig {
  // Input
  url?: string;
  dir?: string;
  sitemap?: boolean;
  /**
   * How to treat sitemap URLs whose origin differs from the crawl origin.
   * Static site generators emit absolute production URLs, so crawling
   * localhost otherwise mirrors production.
   * - "rewrite" (default): point them at the crawl origin
   * - "strict": refuse and exit non-zero
   * - "follow": historic behaviour, fetch them as listed
   */
  sitemapOrigin?: SitemapOrigin;

  // Filtering
  include?: string[];
  exclude?: string[];

  // Output
  outDir?: string;
  llmsTxt?: boolean;
  llmsCtx?: boolean;
  /**
   * Origin the output will be served from, when it differs from the crawl
   * origin. Every emitted URL is made absolute against it. Defaults to the
   * crawl origin, so leaving it unset changes nothing.
   */
  baseUrl?: string;

  // Customization
  title?: string;
  description?: string;
  sections?: Record<string, SectionSpec>;
  /** Free-text lines rendered under the llms.txt index. */
  notes?: string[];
  titleSource?: TitleSource;

  // Crawl settings
  maxDepth?: number;
  concurrency?: number;
  stripSelectors?: string[];
  /**
   * Apply stripSelectors to the source DOM before Readability, as versions
   * up to 0.1.1 did. This can change which node Readability scores as the
   * article root, so removing a small block can delete the section around it.
   */
  stripSource?: boolean;

  // Diagnostics
  /** Treat any warning as a failure and exit non-zero. For CI. */
  strict?: boolean;
  /** Audit only: report what an agent would be able to read, write nothing. */
  report?: boolean;
  /** Shell command serving the site; started before the crawl, killed after. */
  serve?: string;
}

export interface PageResult {
  url: string;
  path: string;
  title: string;
  markdown: string;
  description?: string;
  section?: string;
  /** The page's own <title>, kept to offer when og:title is duplicated. */
  fallbackTitle?: string;
}

export interface GenerateResult {
  pages: PageResult[];
  llmsTxt: string;
  llmsCtx?: string;
  outputDir: string;
  /** Findings from the content-loss guard and the cross-page checks. */
  diagnostics: Diagnostic[];
}
