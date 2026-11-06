// The gateway starts here: `npm start`, checkouts and services from older versions run
// `node server/gateway.mjs`, so this path must stay. The gateway itself is gateway.mts, which Node
// runs as TypeScript (Node 22.18 or newer); an older Node gets a clear message instead.
if (!process.features?.typescript) {
  process.stderr.write(`threebot: needs Node.js 22.18 or newer, which runs TypeScript directly; this is ${process.version}.\n`);
  process.exit(1);
}
await import("./gateway.mts");
