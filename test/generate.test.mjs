import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLlmsTxt, generateLlmsCtx } from "../dist/generate.js";

const pages = [
  {
    url: "http://localhost:3000/",
    path: "/index",
    title: "Home",
    markdown: "# Home\n\nWelcome. See [pricing](http://localhost:3000/pricing).",
    description: "The home page",
  },
  {
    url: "http://localhost:3000/docs/start",
    path: "/docs/start",
    title: "Getting Started",
    markdown: "# Getting Started\n\nInstall it.",
  },
  {
    url: "http://localhost:3000/pricing",
    path: "/pricing",
    title: "Pricing",
    markdown: "# Pricing\n\nPlans.",
  },
];

/** §2.1 — output is read from the publish origin, not the crawl origin. */
test("2.1 baseUrl makes every emitted URL absolute", () => {
  const txt = generateLlmsTxt(pages, { baseUrl: "https://example.com" });
  assert.match(txt, /\(https:\/\/example\.com\/index\.html\.md\)/);
  assert.match(txt, /\(https:\/\/example\.com\/pricing\.html\.md\)/);
  assert.match(txt, /\(https:\/\/example\.com\/docs\/start\.html\.md\)/);
  assert.doesNotMatch(txt, /localhost/);
});

test("2.1 without baseUrl, links stay site-relative as before", () => {
  const txt = generateLlmsTxt(pages, {});
  assert.match(txt, /\(\/pricing\.html\.md\)/);
  assert.doesNotMatch(txt, /https:\/\/example\.com/);
});

test("2.1 llms-ctx Source lines use the publish origin", () => {
  const ctx = generateLlmsCtx(pages, { baseUrl: "https://example.com" });
  assert.match(ctx, /Source: https:\/\/example\.com\/pricing/);
  assert.doesNotMatch(ctx, /Source: http:\/\/localhost/);
});

test("2.1 llms-ctx falls back to the crawl URL when no baseUrl is set", () => {
  const ctx = generateLlmsCtx(pages, {});
  assert.match(ctx, /Source: http:\/\/localhost:3000\/pricing/);
});

/** §2.3 — the most useful lines in an llms.txt are often not crawled pages. */
test("2.3 a section can hold literal external entries", () => {
  const txt = generateLlmsTxt(pages, {
    sections: {
      Docs: "/docs/**",
      "For agents and developers": [
        {
          title: "OpenAPI specification",
          url: "https://api.example.com/openapi.json",
          description: "Every endpoint, request and response",
        },
        { title: "CLI", url: "https://www.npmjs.com/package/@example/cli" },
      ],
    },
  });

  assert.match(txt, /## For agents and developers/);
  assert.match(
    txt,
    /- \[OpenAPI specification\]\(https:\/\/api\.example\.com\/openapi\.json\): Every endpoint/
  );
  assert.match(txt, /- \[CLI\]\(https:\/\/www\.npmjs\.com\/package\/@example\/cli\)\n/);
});

test("2.3 an external-only section survives even though no page matched it", () => {
  const txt = generateLlmsTxt(pages, {
    sections: {
      Nothing: "/no-such/**",
      External: [{ title: "Spec", url: "https://example.com/spec" }],
    },
  });
  assert.doesNotMatch(txt, /## Nothing/);
  assert.match(txt, /## External/);
});

test("2.3 a section accepts several globs", () => {
  const txt = generateLlmsTxt(pages, {
    sections: { Everything: ["/docs/**", "/pricing"] },
  });
  const section = txt.split("## Everything")[1];
  assert.match(section, /Getting Started/);
  assert.match(section, /Pricing/);
});

test("2.3 notes are rendered under the index", () => {
  const txt = generateLlmsTxt(pages, {
    notes: ["Built from the 2026-01 release.", "Prices exclude tax."],
  });
  assert.match(txt, /Built from the 2026-01 release\./);
  assert.match(txt, /Prices exclude tax\./);
  // Notes sit above the link list.
  assert.ok(txt.indexOf("Prices exclude tax.") < txt.indexOf("](/index.html.md)"));
});

test("sections keep their declared order", () => {
  const txt = generateLlmsTxt(pages, {
    sections: { Pricing: "/pricing", Docs: "/docs/**" },
  });
  assert.ok(txt.indexOf("## Pricing") < txt.indexOf("## Docs"));
});

/**
 * §2.1 (follow-up) — a plain origin substitution missed relative links and
 * skipped directory builds entirely, so mirrors kept localhost destinations.
 */
test("2.1 baseUrl rewrites relative mirror links on a directory build", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { agentReady } = await import("../dist/index.js");
  const { FILLER } = await import("./fixtures.mjs");

  const dir = mkdtempSync(join(tmpdir(), "stm-base-"));
  const site = join(dir, "site");
  mkdirSync(site);
  writeFileSync(
    join(site, "index.html"),
    `<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1>` +
      `<p>${FILLER}</p><p>See <a href="/pricing">pricing</a>, ` +
      `<a href="docs/start">docs</a>, ` +
      `<a href="https://other.example/x">elsewhere</a>, ` +
      `<a href="#top">top</a>.</p></main></body></html>`
  );

  const result = await agentReady({
    dir: site,
    outDir: join(dir, "out"),
    baseUrl: "https://mysite.com",
    report: true,
  });

  const md = result.pages[0].markdown;
  assert.match(md, /\[pricing\]\(https:\/\/mysite\.com\/pricing\)/);
  assert.match(md, /\[docs\]\(https:\/\/mysite\.com\/docs\/start\)/);
  assert.doesNotMatch(md, /localhost/, "no crawl-time host may survive");

  // Off-site links and in-page anchors are left as they were.
  assert.match(md, /\[elsewhere\]\(https:\/\/other\.example\/x\)/);
  assert.match(md, /\[top\]\(#top\)/);
});

test("2.1 an off-site link is never rebased onto baseUrl", async () => {
  const { generateLlmsTxt } = await import("../dist/generate.js");
  // Sanity check on the index side: external section entries stay verbatim.
  const txt = generateLlmsTxt(pages, {
    baseUrl: "https://mysite.com",
    sections: { Ext: [{ title: "Spec", url: "https://api.other.com/spec.json" }] },
  });
  assert.match(txt, /\(https:\/\/api\.other\.com\/spec\.json\)/);
});

test("2.3 a site-relative external entry obeys baseUrl", () => {
  const txt = generateLlmsTxt(pages, {
    baseUrl: "https://mysite.com",
    sections: {
      Ext: [
        { title: "Spec", url: "/openapi.json" },
        { title: "Offsite", url: "https://other.example/x" },
      ],
    },
  });
  assert.match(txt, /\[Spec\]\(https:\/\/mysite\.com\/openapi\.json\)/);
  // An absolute entry is already addressable and must pass through untouched.
  assert.match(txt, /\[Offsite\]\(https:\/\/other\.example\/x\)/);
});

/**
 * The mirror path has any extension stripped, so building the source line from
 * it cited /guide for a page actually served at /guide.html.
 */
test("2.1 llms-ctx Source keeps the page's real URL, extension and all", () => {
  const withExt = [
    {
      url: "http://localhost:3000/guide.html",
      path: "/guide",
      title: "Guide",
      markdown: "# Guide",
    },
  ];
  const ctx = generateLlmsCtx(withExt, { baseUrl: "https://mysite.com" });
  assert.match(ctx, /Source: https:\/\/mysite\.com\/guide\.html/);
  assert.doesNotMatch(ctx, /Source: https:\/\/mysite\.com\/guide\n/);
  // Never the crawl origin.
  assert.doesNotMatch(ctx, /localhost/);
});

test("2.1 llms-ctx Source keeps a query string", () => {
  const withQuery = [
    { url: "http://localhost:3000/doc?v=2", path: "/doc", title: "Doc", markdown: "# Doc" },
  ];
  const ctx = generateLlmsCtx(withQuery, { baseUrl: "https://mysite.com" });
  assert.match(ctx, /Source: https:\/\/mysite\.com\/doc\?v=2/);
});

test("a glob's literal dot cannot match any character", () => {
  const versioned = [
    { url: "/", path: "/docs/v1X0/intro", title: "Wrong", markdown: "#" },
    { url: "/", path: "/docs/v1.0/intro", title: "Right", markdown: "#" },
  ];
  const txt = generateLlmsTxt(versioned, { sections: { Docs: "/docs/v1.0/**" } });
  const section = txt.split("## Docs")[1] || "";
  assert.match(section, /Right/);
  assert.doesNotMatch(section, /Wrong/);
});

test("titles and descriptions cannot break the llms.txt list format", () => {
  const awkward = [
    {
      url: "/",
      path: "/p",
      title: "Guide [v2]",
      markdown: "# Guide",
      description: "First line.\nSecond line.",
    },
  ];
  const txt = generateLlmsTxt(awkward, {});
  const entries = txt.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(entries.length, 1);
  // The whole description stays on the entry's own line.
  assert.match(entries[0], /First line\. Second line\./);
  // Brackets in the title are escaped so the link still parses.
  assert.match(entries[0], /\\\[v2\\\]/);
});
