// The process that actually holds the port. Started by forking-server.mjs so
// that killing only the spawned process leaves this one listening — the
// failure mode --serve has to defend against.
import { createServer } from "node:http";

const port = Number(process.env.PORT);

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><html><head><title>Served</title></head><body><main>` +
      `<h1>Served</h1><p>${"Content served by the leaf process. ".repeat(10)}</p>` +
      `</main></body></html>`
  );
}).listen(port, "127.0.0.1");
