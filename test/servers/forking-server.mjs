// Stands in for `next start`: the process we spawn is not the one holding the
// port. It forks a child and then just sits there.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

fork(fileURLToPath(new URL("./leaf-server.mjs", import.meta.url)), {
  env: process.env,
  stdio: "ignore",
});

// Stay alive so the group has a leader to kill.
setInterval(() => {}, 1 << 30);
