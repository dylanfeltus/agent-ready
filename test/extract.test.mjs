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
