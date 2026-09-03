// Leader forks the stubborn server and exits promptly on SIGTERM itself.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

fork(fileURLToPath(new URL("./stubborn-leaf.mjs", import.meta.url)), {
  env: process.env,
  stdio: "ignore",
});

setInterval(() => {}, 1 << 30);
