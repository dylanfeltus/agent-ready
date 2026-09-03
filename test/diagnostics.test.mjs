import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  Diagnostics,
  checkContentLoss,
  checkDuplicateTitles,
  measureDom,
  measureMarkdown,
  renderReport,
} from "../dist/diagnostics.js";
import { agentReady } from "../dist/index.js";
import { page, pricingTable, productionSitemap, serveFixtures } from "./fixtures.mjs";

const metrics = (over = {}) => ({
  textLength: 1000,
  headings: 5,
  tables: 1,
  lists: 2,
  links: 10,
  ...over,
});

/** §1.4 — the generic guard, which is what catches the next unknown bug. */
test("1.4 a collapsed page is flagged", () => {
  const d = new Diagnostics();
  checkContentLoss("/pricing", metrics(), metrics({ textLength: 80, headings: 1, tables: 0 }), d);

  const found = d.byCode("content-loss");
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "warn");
  assert.match(found[0].message, /\/pricing/);
  assert.match(found[0].message, /8% of source text/);
  assert.match(found[0].message, /4 headings lost/);
  assert.match(found[0].message, /1 table lost/);
});

test("1.4 a faithful page is not flagged", () => {
  const d = new Diagnostics();
  checkContentLoss("/about", metrics(), metrics({ textLength: 950 }), d);
  assert.equal(d.all.length, 0);
});

test("1.4 a lost table is flagged even when the text survives", () => {
  const d = new Diagnostics();
  checkContentLoss("/pricing", metrics(), metrics({ tables: 0 }), d);
  assert.equal(d.byCode("content-loss").length, 1);
  assert.match(d.all[0].message, /1 table lost/);
});

test("1.4 short pages do not trip the ratio check", () => {
  const d = new Diagnostics();
  checkContentLoss("/tiny", metrics({ textLength: 100, headings: 1, tables: 0, lists: 0 }),
    metrics({ textLength: 20, headings: 1, tables: 0, lists: 0 }), d);
  assert.equal(d.all.length, 0);
});

test("1.4 markdown measurement counts headings, tables, lists and links", () => {
  const md = [
    "# Title",
    "",
    "## Section",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "- one",
    "- two",
    "",
    "See [docs](/docs).",
  ].join("\n");

  const m = measureMarkdown(md);
  assert.equal(m.headings, 2);
  assert.equal(m.tables, 1);
  assert.equal(m.lists, 1);
  assert.equal(m.links, 1);
});

test("1.4 dom measurement counts the same structures", () => {
  const dom = new JSDOM(
    "<body><h1>a</h1><h2>b</h2><table><tr><td>x</td></tr></table><ul><li>1</li></ul><a href='/x'>l</a></body>"
  );
  const m = measureDom(dom.window.document.body);
  assert.equal(m.headings, 2);
  assert.equal(m.tables, 1);
  assert.equal(m.lists, 1);
  assert.equal(m.links, 1);
});

/** §2.2 — a duplicated title is a signal the tool has enough data to surface. */
test("2.2 duplicate titles are reported with the fallback that would fix them", () => {
  const d = new Diagnostics();
  checkDuplicateTitles(
    [
      { path: "/", title: "Example — the tagline", fallbackTitle: "Example — the tagline" },
      { path: "/pricing", title: "Example — the tagline", fallbackTitle: "Pricing — Example" },
      { path: "/about", title: "Example — the tagline", fallbackTitle: "About — Example" },
    ],
    d
  );

  const found = d.byCode("duplicate-title");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /3 pages share the title "Example — the tagline"/);
  assert.match(found[0].detail, /Pricing — Example/);
});

test("2.2 distinct titles produce no finding", () => {
  const d = new Diagnostics();
  checkDuplicateTitles([{ path: "/", title: "Home" }, { path: "/x", title: "X" }], d);
  assert.equal(d.all.length, 0);
});

/** End-to-end: a site-wide og:title is repaired and reported, not left wrong. */
test("2.2 a shared og:title is repaired from each page's <title>", async () => {
  const shared = "Example — the tagline";
  const site = await serveFixtures({
    "/sitemap.xml": { type: "application/xml", body: productionSitemap(["/", "/pricing", "/about"]) },
    "/": { body: page({ title: "Home — Example", og: shared, body: "<p>Home body text here.</p>" }) },
    "/pricing": { body: page({ title: "Pricing — Example", og: shared, body: "<p>Pricing body text.</p>" }) },
    "/about": { body: page({ title: "About — Example", og: shared, body: "<p>About body text.</p>" }) },
  });

  try {
    const result = await agentReady({ url: site.origin, report: true });
    const titles = result.pages.map((p) => p.title).sort();
    assert.deepEqual(titles, ["About — Example", "Home — Example", "Pricing — Example"]);

    // The repair is announced rather than done silently.
    assert.equal(result.diagnostics.filter((d) => d.code === "title-fallback").length, 1);
    // Each mirror's H1 was updated too.
    const pricing = result.pages.find((p) => p.path === "/pricing");
    assert.match(pricing.markdown, /^# Pricing — Example/);
  } finally {
    await site.close();
  }
});

test("2.2 --title-source og keeps the shared title and warns", async () => {
  const shared = "Example — the tagline";
  const site = await serveFixtures({
    "/sitemap.xml": { type: "application/xml", body: productionSitemap(["/", "/pricing"]) },
    "/": { body: page({ title: "Home — Example", og: shared, body: "<p>Home body text here.</p>" }) },
    "/pricing": { body: page({ title: "Pricing — Example", og: shared, body: "<p>Pricing body text.</p>" }) },
  });

  try {
    const result = await agentReady({ url: site.origin, report: true, titleSource: "og" });
    assert.deepEqual(result.pages.map((p) => p.title), [shared, shared]);
    assert.equal(result.diagnostics.filter((d) => d.code === "duplicate-title").length, 1);
  } finally {
    await site.close();
  }
});

/** §5 — the audit renders the same records and invents no score. */
test("5 report lists findings without a made-up score", () => {
  const d = new Diagnostics();
  d.add({ level: "warn", code: "content-loss", message: "/about — output is 11% of source text" });
  d.add({ level: "ok", code: "extracted", message: "12 pages extracted cleanly" });
  d.add({ level: "error", code: "no-llms", message: "no /llms.txt" });

  const out = renderReport("example.com", d);
  // Most severe first.
  assert.ok(out.indexOf("✗ no /llms.txt") < out.indexOf("⚠ /about"));
  assert.ok(out.indexOf("⚠ /about") < out.indexOf("✓ 12 pages"));
  assert.doesNotMatch(out, /%\s*agent-ready/);
});

test("5 --report writes nothing", async () => {
  const { mkdtempSync, existsSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const out = join(mkdtempSync(join(tmpdir(), "stm-")), "out");
  const site = await serveFixtures({
    "/sitemap.xml": { type: "application/xml", body: productionSitemap(["/"]) },
    "/": { body: page({ title: "Home", body: "<p>Home body text here for length.</p>" }) },
  });

  try {
    const result = await agentReady({ url: site.origin, outDir: out, report: true });
    assert.ok(result.pages.length > 0);
    assert.equal(existsSync(out), false, "report mode must not create the output directory");
  } finally {
    await site.close();
  }
});

/** The guard catches Readability pruning a sparse table — the mechanism the
 *  work order suspected, which is real for low-content tables. */
test("1.4 the guard notices when a sparse table is pruned by extraction", async () => {
  const site = await serveFixtures({
    "/sitemap.xml": { type: "application/xml", body: productionSitemap(["/"]) },
    "/": { body: page({ title: "Pricing", body: pricingTable() }) },
  });

  try {
    const result = await agentReady({ url: site.origin, report: true });
    // Either the table survived, or its loss was reported. Never silent.
    const md = result.pages[0].markdown;
    const flagged = result.diagnostics.some(
      (d) => d.code === "content-loss" && /table/.test(d.message)
    );
    assert.ok(md.includes("| --- |") || flagged, "a lost table must be reported");
  } finally {
    await site.close();
  }
});

test("two pages writing to one mirror file are reported, not silently merged", async () => {
  const site = await serveFixtures({
    "/sitemap.xml": {
      type: "application/xml",
      body: productionSitemap(["/guide", "/guide.html"]),
    },
    "/guide": { body: page({ title: "Guide", body: "<p>Extensionless guide body.</p>" }) },
    "/guide.html": { body: page({ title: "Guide", body: "<p>Extensioned guide body.</p>" }) },
  });

  try {
    const result = await agentReady({ url: site.origin, report: true });
    const collisions = result.diagnostics.filter((d) => d.code === "mirror-collision");
    assert.equal(collisions.length, 1);
    assert.match(collisions[0].message, /only the last survives/);
  } finally {
    await site.close();
  }
});
