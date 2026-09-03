import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { FILLER } from "./fixtures.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const LEAF = fileURLToPath(new URL("./servers/leaf-server.mjs", import.meta.url));

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "stm-cli-"));
  const site = join(dir, "site");
  mkdirSync(site);
  writeFileSync(
    join(site, "index.html"),
    `<!doctype html><html><head><title>Home</title></head><body><main>` +
      `<h1>Home</h1><p>${FILLER}</p><p>See <a href="/pricing">pricing</a>.</p>` +
      `</main></body></html>`
  );
  return { dir, site };
}

/**
 * Run the CLI to completion.
 *
 * Both streams are watched: ora writes its progress lines to stderr, so a
 * test that only reads stdout would miss the server coming up.
 */
function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    const notify = () => options.onOutput?.(stdout + stderr, child);
    child.stdout.on("data", (d) => { stdout += d; notify(); });
    child.stderr.on("data", (d) => { stderr += d; notify(); });
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr, output: stdout + stderr })
    );
  });
}

async function portIsFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("a serve command in the config file is honoured", async () => {
  const { dir } = workspace();
  writeFileSync(
    join(dir, "site-to-md.config.js"),
    `export default { serve: ${JSON.stringify(`node ${LEAF}`)}, report: true };\n`
  );

  // No positional target: the configured serve command has to supply it.
  const { code, stdout, output } = await runCli(
    ["--config", join(dir, "site-to-md.config.js")],
    { cwd: dir }
  );

  assert.equal(code, 0, output);
  // With no positional target, reaching a localhost URL at all proves the
  // configured serve command supplied it.
  assert.match(stdout, /Auditing http:\/\/localhost:\d+/);
  assert.doesNotMatch(output, /Usage:/, "should not have fallen back to help");
});

test("report mode from the config file shows the audit and writes nothing", async () => {
  const { dir, site } = workspace();
  const out = join(dir, "out");
  writeFileSync(
    join(dir, "site-to-md.config.js"),
    `export default { report: true, outDir: ${JSON.stringify(out)} };\n`
  );

  const { code, stdout, output } = await runCli(
    [site, "--config", join(dir, "site-to-md.config.js")],
    { cwd: dir }
  );

  assert.equal(code, 0, output);
  assert.match(stdout, /extracted cleanly/);
  // The normal run's Output block would advertise files that were never made.
  assert.doesNotMatch(stdout, /llms\.txt/);
  assert.equal(existsSync(out), false, "report mode must not write");
});

/**
 * Installing a SIGINT listener suppresses Node's default termination, so the
 * process has to exit itself — otherwise Ctrl-C stops the server and lets the
 * crawl continue against it, writing an incomplete mirror and exiting 0.
 */
test("Ctrl-C during --serve stops the server and exits non-zero", async () => {
  const { dir } = workspace();
  const out = join(dir, "out");

  let port;
  const run = runCli(
    ["--serve", `node ${LEAF}`, "--out", out],
    {
      cwd: dir,
      onOutput: (text, child) => {
        const match = text.match(/localhost:(\d+)/);
        if (match && !port) {
          port = Number(match[1]);
          child.kill("SIGINT");
        }
      },
    }
  );

  const { code } = await run;

  assert.ok(port, "server should have reported a port");
  assert.notEqual(code, 0, "interrupted run must not report success");
  assert.equal(await portIsFree(port), true, "server should have been stopped");
});
