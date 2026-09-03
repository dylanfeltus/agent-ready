import { createServer } from "node:http";

/** Enough prose that Readability treats the page as an article. */
export const FILLER = "Choose a plan that fits the way your team actually works. ".repeat(8);

export const FEATURES = [
  "Custom domain",
  "Analytics",
  "Priority support",
  'Remove "powered by" badge',
  "API access",
  "SSO",
  "Audit log",
  "White-label",
];

/** [name, included flags] for three plans across the eight features above. */
export const PLANS = [
  ["Free", [1, 1, 0, 0, 0, 0, 0, 0]],
  ["Pro", [1, 1, 1, 1, 1, 0, 0, 0]],
  ["Enterprise", [1, 1, 1, 1, 1, 1, 1, 1]],
];

const icon = (on) =>
  `<svg aria-label="${on ? "included" : "not included"}" class="icon"></svg>`;

/** Three plan cards, each listing all eight features with a tick or cross. */
export function pricingCards() {
  const cards = PLANS.map(
    ([name, flags]) =>
      `<div class="plan"><h3>${name}</h3><ul>` +
      FEATURES.map((f, i) => `<li>${icon(flags[i])}<span>${f}</span></li>`).join("") +
      `</ul></div>`
  ).join("");
  return `<div class="grid">${cards}</div>`;
}

/** The same data as a real comparison table. */
export function pricingTable() {
  let html =
    "<table><thead><tr><th>Feature</th>" +
    PLANS.map(([name]) => `<th>${name}</th>`).join("") +
    "</tr></thead><tbody>";
  for (let i = 0; i < FEATURES.length; i++) {
    html +=
      `<tr><td>${FEATURES[i]}</td>` +
      PLANS.map(([, flags]) => `<td>${icon(flags[i])}</td>`).join("") +
      "</tr>";
  }
  return html + "</tbody></table>";
}

export function page({ title = "Pricing", og, body = "", head = "" }) {
  return `<!doctype html><html><head><title>${title}</title>${
    og ? `<meta property="og:title" content="${og}">` : ""
  }${head}</head><body><main><h1>${title}</h1><p>${FILLER}</p>${body}</main></body></html>`;
}

/**
 * Serve a fixed route table on an ephemeral port.
 * Returns { origin, close }.
 */
export async function serveFixtures(routes) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>not found</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": route.type || "text/html" });
    res.end(route.body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A sitemap listing absolute production URLs, as SSGs emit by default. */
export function productionSitemap(paths, origin = "https://example.com") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join("\n")}
</urlset>`;
}

/**
 * Convert a fragment straight to markdown, skipping Readability.
 *
 * Readability prunes low-content tables, so a fixture small enough to make one
 * conversion rule legible would never reach the converter through the full
 * pipeline. This exercises the same conversion path extractPage uses.
 */
export async function toMarkdown(html) {
  const { JSDOM } = await import("jsdom");
  const { createTurndown, resolveIcons } = await import("../dist/markdown.js");
  const body = new JSDOM(`<body>${html}</body>`).window.document.body;
  const lostIcons = resolveIcons(body);
  const { service, loss } = createTurndown();
  return {
    markdown: service.turndown(body.innerHTML).trim(),
    lostIcons: lostIcons + loss.lostIcons,
    degradedTables: loss.degradedTables,
  };
}

/** A sitemap *index* pointing at child sitemaps on the production origin. */
export function productionSitemapIndex(children, origin = "https://example.com") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${children.map((p) => `  <sitemap><loc>${origin}${p}</loc></sitemap>`).join("\n")}
</sitemapindex>`;
}
