# Contributing

```sh
npm run setup
npm run check
```

`npm run dev` serves the web app on port 5180 and proxies to a gateway on `127.0.0.1:3780`. `scripts/fixture.mjs` runs the real gateway against a scripted T3, so most work needs no real agents.

Keep changes small and include a test. Bots are threads, not roles: new features should build on T3 Code's primitives rather than duplicate them.
