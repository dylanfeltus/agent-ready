// Stands in for a dev server that does NOT fail on a busy port: it tries the
// port it was given, and quietly moves to the next one if that is taken.
import { createServer } from "node:http";

const wanted = Number(process.env.PORT);

function listen(port) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(String(port));
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") listen(port + 1);
    else throw err;
  });
  server.listen(port, "127.0.0.1");
}

listen(wanted);
setInterval(() => {}, 1 << 30);
