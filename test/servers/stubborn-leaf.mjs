// A server that ignores SIGTERM, as real ones sometimes do while draining.
// The group leader still exits promptly, so this is the case where trusting
// the leader's exit would leave the port held.
import { createServer } from "node:http";

process.on("SIGTERM", () => { /* deliberately ignored */ });

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><main><h1>Stubborn</h1></main></body></html>");
}).listen(Number(process.env.PORT), "127.0.0.1");
