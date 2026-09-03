import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlSite, reconcileSitemapUrls, ForeignSitemapError } from "../dist/crawl.js";
import { Diagnostics } from "../dist/diagnostics.js";
import {
  page,
  productionSitemap,
  productionSitemapIndex,
  serveFixtures,
} from "./fixtures.mjs";

/**
 * Acceptance test for §1.2.
 *
 * "serving a sitemap of https://example.com/* from http://localhost:PORT must
 * crawl localhost, or exit non-zero explaining why it will not."
 *
 * The local pages say LOCAL BUILD; production would say something else. If the
 * crawler follows the sitemap verbatim it reaches example.com and this fails.
 */
async function withLocalSite(run, extraRoutes = {}) {
  const site = await serveFixtures({
    "/sitemap.xml": {
      type: "application/xml",
      body: productionSitemap(["/", "/pricing", "/about"]),
    },
    "/": { body: page({ title: "Home", body: "<p>LOCAL BUILD home content here.</p>" }) },
    "/pricing": { body: page({ title: "Pricing", body: "<p>LOCAL BUILD pricing is $10.</p>" }) },
    "/about": { body: page({ title: "About", body: "<p>LOCAL BUILD about content.</p>" }) },
    ...extraRoutes,
  });

  try {
    return await run(site);
  } finally {
    await site.close();
  }
}

test("1.2 a production sitemap served from localhost crawls localhost", async () => {
  await withLocalSite(async (site) => {
    const diagnostics = new Diagnostics();
    const results = await crawlSite({ url: site.origin }, diagnostics);

    assert.equal(results.length, 3, "all three sitemap entries should be crawled");

    for (const result of results) {
      assert.equal(
        new URL(result.url).origin,
        site.origin,
        `crawled ${result.url}, which is not the origin under test`
      );
      assert.match(result.html, /LOCAL BUILD/);
    }

    // The rewrite is reported, never silent.
    const rewritten = diagnostics.byCode("sitemap-rewritten");
    assert.equal(rewritten.length, 1);
    assert.match(rewritten[0].message, /example\.com/);
  });
});

test("1.2 --sitemap-origin strict refuses and explains", async () => {
  await withLocalSite(async (site) => {
    await assert.rejects(
      () => crawlSite({ url: site.origin, sitemapOrigin: "strict" }, new Diagnostics()),
      (err) => {
        assert.ok(err instanceof ForeignSitemapError);
        assert.match(err.message, /different origin/);
        assert.match(err.message, /example\.com/);
        assert.match(err.message, new RegExp(site.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      }
    );
  });
});

test("1.2 a same-origin sitemap is left alone", () => {
  const diagnostics = new Diagnostics();
  const urls = ["http://localhost:3000/", "http://localhost:3000/pricing"];
  const out = reconcileSitemapUrls(urls, "http://localhost:3000", "rewrite", diagnostics);
  assert.deepEqual(out, urls);
  assert.equal(diagnostics.all.length, 0);
});

test("1.2 rewriting preserves path and query", () => {
  const out = reconcileSitemapUrls(
    ["https://example.com/docs/page?v=2"],
    "http://localhost:3000",
    "rewrite"
  );
  assert.deepEqual(out, ["http://localhost:3000/docs/page?v=2"]);
});

test("1.2 follow mode keeps the old behaviour but warns loudly", () => {
  const diagnostics = new Diagnostics();
  const urls = ["https://example.com/pricing"];
  const out = reconcileSitemapUrls(urls, "http://localhost:3000", "follow", diagnostics);
  assert.deepEqual(out, urls);
  const warned = diagnostics.byCode("sitemap-foreign-origin");
  assert.equal(warned.length, 1);
  assert.equal(warned[0].level, "warn");
});

test("1.2 pages that cannot be fetched are reported, not silently dropped", async () => {
  const site = await serveFixtures({
    "/sitemap.xml": {
      type: "application/xml",
      body: productionSitemap(["/", "/missing"]),
    },
    "/": { body: page({ title: "Home", body: "<p>LOCAL BUILD home.</p>" }) },
  });

  try {
    const diagnostics = new Diagnostics();
    const results = await crawlSite({ url: site.origin }, diagnostics);
    assert.equal(results.length, 1);
    const failures = diagnostics.byCode("fetch-failed");
    assert.equal(failures.length, 1);
    assert.match(failures[0].detail, /missing/);
  } finally {
    await site.close();
  }
});

/**
 * A sitemap index's children are references that need the same origin check as
 * its URLs. Rewriting them first meant strict mode silently fell back to link
 * crawling instead of refusing the foreign sitemap it was handed.
 */
test("1.2 strict mode refuses a sitemap index whose children are off-origin", async () => {
  const site = await serveFixtures({
    "/sitemap.xml": {
      type: "application/xml",
      body: productionSitemapIndex(["/sitemap-pages.xml"]),
    },
    "/sitemap-pages.xml": {
      type: "application/xml",
      body: productionSitemap(["/", "/pricing"]),
    },
    "/": { body: page({ title: "Home", body: "<p>LOCAL BUILD home content.</p>" }) },
    "/pricing": { body: page({ title: "Pricing", body: "<p>LOCAL BUILD pricing.</p>" }) },
  });

  try {
    await assert.rejects(
      () => crawlSite({ url: site.origin, sitemapOrigin: "strict" }, new Diagnostics()),
      (err) => {
        assert.ok(err instanceof ForeignSitemapError);
        assert.match(err.message, /example\.com/);
        return true;
      }
    );
  } finally {
    await site.close();
  }
});

test("1.2 a sitemap index with off-origin children is rewritten and crawled", async () => {
  const site = await serveFixtures({
    "/sitemap.xml": {
      type: "application/xml",
      body: productionSitemapIndex(["/sitemap-pages.xml"]),
    },
    "/sitemap-pages.xml": {
      type: "application/xml",
      body: productionSitemap(["/", "/pricing"]),
    },
    "/": { body: page({ title: "Home", body: "<p>LOCAL BUILD home content.</p>" }) },
    "/pricing": { body: page({ title: "Pricing", body: "<p>LOCAL BUILD pricing.</p>" }) },
  });

  try {
    const diagnostics = new Diagnostics();
    const results = await crawlSite({ url: site.origin }, diagnostics);

    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(new URL(r.url).origin, site.origin);
      assert.match(r.html, /LOCAL BUILD/);
    }
    // Both the index reference and the page URLs are reported as rewritten.
    assert.ok(diagnostics.byCode("sitemap-rewritten").length >= 1);
  } finally {
    await site.close();
  }
});
