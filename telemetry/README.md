# Usage-stats collector

A Cloudflare Worker with one D1 database that receives Threebot's opt-in usage pings ([PRIVACY.md](../PRIVACY.md)). Deployed at `https://stats.swk.tools` (by hand, not by CI).

- `POST /v1/ping`: validates the ping against schema 1 ([`src/schema.ts`](src/schema.ts)), rebuilds it from known fields only, and stores one ping per install ID per UTC day (later ones get `429`). It reads no IP address, user agent or other header, and `observability` is off in `wrangler.toml` so Cloudflare keeps no request logs for it.
- `GET /v1/stats?days=30`: installs per day, installs by version, and tokens by model per day. Needs `Authorization: Bearer <STATS_TOKEN>`; without the secret set it answers 404.
- [`queries.sql`](queries.sql): the same and more for `wrangler d1 execute`.

## Deploy

```sh
cd telemetry
npx wrangler login
npx wrangler d1 create threebot-telemetry          # put the database_id in wrangler.toml
npx wrangler d1 execute threebot-telemetry --remote --file schema.sql
npx wrangler secret put STATS_TOKEN                # any long random string
npx wrangler deploy                                # prints https://threebot-telemetry.<account>.workers.dev
```

To use your own domain, add a route in `wrangler.toml` (for example `routes = [{ pattern = "stats.example.com", custom_domain = true }]`).

Then set `TELEMETRY_ENDPOINT` in [`server/telemetry.mts`](../server/telemetry.mts) to `https://<host>/v1/ping` and release. Until it is set, Threebot sends nothing even when a user turns stats on. To try a collector without a release, run a gateway with `THREEBOT_TELEMETRY_URL=https://<host>/v1/ping`.

Retention: a daily Cron Trigger (`scheduled` in `src/worker.ts`) deletes rows older than 400 days. The two `DELETE` statements at the end of `queries.sql` do the same by hand.

## Test

`npm run check` at the repo root runs `test/worker.test.ts` (validation, the Worker against the real `schema.sql` on `node:sqlite`, the stats endpoint and every query in `queries.sql`) and type-checks the Worker.
