import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPage } from "../dist/extract.js";
import {
  FEATURES,
  PLANS,
  page,
  pricingCards,
  pricingTable,
  toMarkdown,
} from "./fixtures.mjs";

const URL_ = "http://x.test/pricing";

/**
 * Acceptance test for §1.1.
 *
 * "a fixture page with three cards × eight tick/cross rows must round-trip
 * with every row present and every tick/cross distinguishable."
 */
test("1.1 card grid: every row present and every tick/cross distinguishable", () => {
  const { page: result } = extractPage(URL_, page({ body: pricingCards() }), {});
  const md = result.markdown;

  // Every plan and every feature survives, once per plan.
  for (const [name] of PLANS) assert.match(md, new RegExp(`### ${name}`));
  for (const feature of FEATURES) {
    const escaped = feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const occurrences = md.match(new RegExp(escaped, "g")) || [];
    assert.equal(occurrences.length, PLANS.length, `"${feature}" should appear once per plan`);
  }

  // Each plan's section carries exactly the ticks and crosses it should.
  const sections = md.split(/^### /m).slice(1);
  assert.equal(sections.length, PLANS.length);

  for (const [i, [name, flags]] of PLANS.entries()) {
    const section = sections[i];
    assert.ok(section.startsWith(name), `section ${i} should be ${name}`);
    const expectedYes = flags.filter(Boolean).length;
    const expectedNo = flags.length - expectedYes;
    assert.equal((section.match(/✓/g) || []).length, expectedYes, `${name} tick count`);
    assert.equal((section.match(/—/g) || []).length, expectedNo, `${name} cross count`);
  }

  // The reporter's exact symptom: Free must not appear to include this.
  const free = sections[0];
  assert.match(free, /— Remove "powered by" badge/);
});

test("1.1 comparison table: renders as a markdown table with resolved cells", () => {
  const { page: result, report } = extractPage(URL_, page({ body: pricingTable() }), {});
  const md = result.markdown;

  assert.match(md, /\| Feature \| Free \| Pro \| Enterprise \|/);
  assert.match(md, /\| --- \| --- \| --- \| --- \|/);
  assert.equal(report.degradedTables, 0);
  assert.equal(report.lostIcons, 0);

  for (const [i, feature] of FEATURES.entries()) {
    const cells = PLANS.map(([, flags]) => (flags[i] ? "✓" : "—"));
    const escaped = feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const row = new RegExp(`\\| ${escaped} \\| ${cells.join(" \\| ")} \\|`);
    assert.match(md, row, `row for "${feature}"`);
  }
});

test("1.1 icon meaning is read from aria-label, title, use and class", async () => {
  const cases = [
    ['<svg aria-label="included"></svg>', "✓"],
    ['<svg aria-label="not included"></svg>', "—"],
    ["<svg><title>Included</title></svg>", "✓"],
    ['<svg><use href="#icon-check"></use></svg>', "✓"],
    ['<svg><use href="#icon-cross"></use></svg>', "—"],
    ['<i class="icon-check"></i>', "✓"],
    ['<i class="icon-times"></i>', "—"],
  ];

  for (const [markup, expected] of cases) {
    const { markdown } = await toMarkdown(
      `<table><tbody><tr><td>Feature</td><td>${markup}</td></tr></tbody></table>`
    );
    assert.match(markdown, new RegExp(`\\| Feature \\| ${expected} \\|`), markup);
  }
});

test("1.1 an unreadable icon is counted as lost rather than guessed", async () => {
  const { lostIcons } = await toMarkdown(
    `<table><tbody><tr><td>Feature</td><td><svg class="ico"></svg></td></tr></tbody></table>`
  );
  assert.equal(lostIcons, 1);
});

test("1.1 aria-hidden decoration is not counted as loss", async () => {
  const { lostIcons } = await toMarkdown(
    `<table><tbody><tr><td>Feature</td><td><svg aria-hidden="true"></svg></td></tr></tbody></table>`
  );
  assert.equal(lostIcons, 0);
});

test("1.1 merged cells degrade honestly instead of misaligning columns", async () => {
  const { markdown, degradedTables } = await toMarkdown(
    "<table><tbody><tr><td colspan='2'>Spans two</td></tr>" +
      "<tr><td>A</td><td>B</td></tr></tbody></table>"
  );
  assert.equal(degradedTables, 1);
  // Text is preserved even though the grid is not.
  assert.match(markdown, /Spans two/);
  assert.match(markdown, /A/);
});

test("1.1 a table cell containing a pipe does not break the row", async () => {
  const { markdown } = await toMarkdown(
    "<table><tbody><tr><td>a|b</td><td>c</td></tr></tbody></table>"
  );
  assert.match(markdown, /a\\\|b/);
});

test("1.1 a table with no thead still gets a header row, keeping every body row", async () => {
  const { markdown, degradedTables } = await toMarkdown(
    "<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>"
  );
  assert.equal(degradedTables, 0);
  assert.match(markdown, /\| --- \| --- \|/);
  assert.match(markdown, /\| A \| B \|/);
  assert.match(markdown, /\| C \| D \|/);
});

/** §1.3 — a strip selector must not take the section around it with it. */
test("1.3 --strip removes only what it matches", () => {
  const body =
    `<section><h2>Features</h2><p>${"Feature detail text. ".repeat(20)}</p>` +
    `<div class="promo">Limited offer</div></section>` +
    `<section><h2>FAQ</h2><p>${"Frequently asked answer text. ".repeat(20)}</p></section>`;

  const html = page({ body });
  const before = extractPage(URL_, html, {}).page.markdown;
  const after = extractPage(URL_, html, { stripSelectors: [".promo"] }).page.markdown;

  assert.match(before, /Limited offer/);
  assert.doesNotMatch(after, /Limited offer/);

  // Everything else is untouched — this is the whole point of the fix.
  assert.match(after, /## FAQ/);
  assert.match(after, /## Features/);
  assert.match(after, /Frequently asked answer text/);

  const lost = before.length - after.length;
  assert.ok(lost < 100, `stripping one small block cost ${lost} chars`);
});

test("1.3 --strip-source restores the pre-0.2 behaviour", () => {
  const body = `<section><h2>Features</h2><p>${"Detail. ".repeat(30)}</p><div class="promo">Offer</div></section>`;
  const html = page({ body });
  const result = extractPage(URL_, html, { stripSelectors: [".promo"], stripSource: true });
  assert.doesNotMatch(result.page.markdown, /Offer/);
});

/** §2.2 — the <title> is kept so a shared og:title can be repaired. */
test("2.2 readability prefers og:title, and <title> is kept as a fallback", () => {
  const html = page({ title: "Pricing — Example", og: "Example — the tagline", body: "<p>x</p>" });
  const { page: result } = extractPage(URL_, html, {});
  assert.equal(result.title, "Example — the tagline");
  assert.equal(result.fallbackTitle, "Pricing — Example");
});

test("2.2 --title-source title forces the document title", () => {
  const html = page({ title: "Pricing — Example", og: "Example — the tagline", body: "<p>x</p>" });
  const { page: result } = extractPage(URL_, html, { titleSource: "title" });
  assert.equal(result.title, "Pricing — Example");
  assert.match(result.markdown, /^# Pricing — Example/);
});

/**
 * An ordinary content image is not an icon. Counting it as an unresolved one
 * produced a false unresolved-icons warning on any page with a picture, which
 * would fail --strict for no reason.
 */
test("1.1 content images are not counted as unresolved icons", () => {
  const body =
    `<p>${"Article prose that carries the page. ".repeat(12)}</p>` +
    `<img src="/hero.png" alt="Our team at the summit">` +
    `<img src="/chart.png" alt="Revenue by quarter">`;

  const { page: result, report } = extractPage(URL_, page({ body }), {});
  assert.equal(report.lostIcons, 0);
  assert.match(result.markdown, /!\[Our team at the summit\]/);
  assert.match(result.markdown, /!\[Revenue by quarter\]/);
});

test("1.1 an altless image with no signal is still counted as lost", async () => {
  const { lostIcons } = await toMarkdown(
    `<table><tbody><tr><td>Feature</td><td><img src="/x.png"></td></tr></tbody></table>`
  );
  assert.equal(lostIcons, 1);
});

test("1.1 an image whose src names a tick still resolves", async () => {
  const { markdown } = await toMarkdown(
    `<table><tbody><tr><td>Feature</td><td><img src="/icons/check.svg"></td></tr></tbody></table>`
  );
  assert.match(markdown, /\| Feature \| ✓ \|/);
});

/**
 * The description used to come from Readability's excerpt, computed before
 * stripping — so stripped text, and the internal strip marks, reached
 * llms.txt even though the mirror was clean.
 */
test("1.3 stripped content never reaches the page description", () => {
  const body =
    `<div class="promo">SECRET PROMO TEXT.</div>` +
    `<p>${"Genuine article prose continues here. ".repeat(20)}</p>`;

  const { page: result } = extractPage(URL_, page({ body }), {
    stripSelectors: [".promo"],
  });

  assert.doesNotMatch(result.markdown, /SECRET PROMO/);
  assert.doesNotMatch(result.description, /SECRET PROMO/);
  // The sentinel used to carry the strip through Readability must never leak.
  assert.doesNotMatch(result.description, /STM/);
  assert.doesNotMatch(result.description, /[\u2062]/);
  // It is still a real description drawn from the surviving article text.
  assert.ok(result.description.length > 40);
  assert.match(result.description, /Choose a plan|Genuine article prose/);
});

test("1.3 a meta description still wins over the derived excerpt", () => {
  const html = page({
    head: '<meta name="description" content="The hand-written summary.">',
    body: `<p>${"Body prose here. ".repeat(20)}</p>`,
  });
  const { page: result } = extractPage(URL_, html, {});
  assert.equal(result.description, "The hand-written summary.");
});

/**
 * A text mark cannot be a child of a void element and does not survive
 * serialization, so --strip used to silently do nothing for `img.promo`.
 */
test("1.3 --strip removes void elements such as images", () => {
  const body =
    `<p>${"Genuine prose that carries the page. ".repeat(20)}</p>` +
    `<img class="promo" src="/promo.png" alt="BUY NOW BANNER">` +
    `<img src="/real.png" alt="A real content image">`;

  const { page: result, report } = extractPage(URL_, page({ body }), {
    stripSelectors: ["img.promo"],
  });

  assert.doesNotMatch(result.markdown, /BUY NOW BANNER/);
  // Only what the selector matched is removed.
  assert.match(result.markdown, /A real content image/);
  assert.equal(report.lostIcons, 0);
});

/**
 * <th> is used for row labels as often as for column headers. Treating a row
 * label as a column header deletes a whole row of data and mislabels the rest.
 */
test("1.1 a matrix using th as row labels keeps every row", async () => {
  const { markdown } = await toMarkdown(
    "<table><tbody>" +
      "<tr><th>Custom domain</th><td>Yes</td></tr>" +
      "<tr><th>Analytics</th><td>Yes</td></tr>" +
      "<tr><th>SSO</th><td>No</td></tr>" +
      "</tbody></table>"
  );

  for (const row of ["Custom domain \\| Yes", "Analytics \\| Yes", "SSO \\| No"]) {
    assert.match(markdown, new RegExp(`\\| ${row} \\|`));
  }
  // The synthesized header is empty; no data row was promoted into it.
  assert.match(markdown, /^\|\s+\|\s+\|$/m);
});

test("1.1 a genuine all-th first row is still used as the header", async () => {
  const { markdown } = await toMarkdown(
    "<table><tbody>" +
      "<tr><th>Feature</th><th>Free</th></tr>" +
      "<tr><td>SSO</td><td>No</td></tr>" +
      "</tbody></table>"
  );
  assert.match(markdown, /\| Feature \| Free \|/);
  assert.match(markdown, /\| SSO \| No \|/);
});
