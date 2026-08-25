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
