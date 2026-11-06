#!/usr/bin/env node
// The `threebot` command starts here. This path must stay: the service unit or launchd plist and the
// ~/.local/bin/threebot wrapper run <home>/runtime/current/server/cli.mjs, they are written once at
// install time, and `threebot update` only swaps `current`. The command itself is cli.mts, which Node
// runs as TypeScript (Node 22.18 or newer); an older Node gets a clear message instead.
if (!process.features?.typescript) {
  process.stderr.write(`threebot: needs Node.js 22.18 or newer, which runs TypeScript directly; this is ${process.version}.\n`);
  process.exit(1);
}
await import("./cli.mts");
