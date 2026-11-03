# Self-hosting

Threebot is one Node process next to a T3 Code server. It keeps everything in `THREEBOT_HOME` (default `~/.threebot`).

## Keep a Bot running

Bots only run while T3 Code and the gateway do, so run both as services on a machine that stays on. A systemd user unit for the gateway:

```ini
[Unit]
Description=Threebot

[Service]
WorkingDirectory=%h/threebot
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=default.target
```

## Reaching it from your phone

The default is `HOST=127.0.0.1` with no sign-in, which is only safe on your own machine. Anyone who reaches an unprotected gateway can drive your agents. Pick one before exposing it:

- **A private network.** Serve it over Tailscale or similar, so only your devices can reach it.
- **Cloudflare Access.** Put a Cloudflare Tunnel in front, and set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `CF_ACCESS_EMAILS`. The gateway checks the Access token on every request.
- **A password.** Set `BOT_PASSWORD`, and use HTTPS in front of it.

Installing the app and receiving notifications on a phone need HTTPS.

## Connected apps

Set the `EXECUTOR_*` values in `.env` to use [Executor](https://executor.sh), self-hosted or cloud. Bots then reach your apps through it, and it holds the credentials. Without it, Bots use the browser and tokens from the Vault.

## Back up

Back up `THREEBOT_HOME`. It holds your Bots, memory and the encrypted Vault. `vault.enc` is useless without `.vault-key`, so keep the key somewhere separate and safe.

## Updating

```sh
git pull
npm run setup
```

Then restart the gateway. Threebot needs T3 Code 0.1.6 or later and is tested on stable releases, so update both together.

## Keep the app off the public internet

Threebot can drive agents on your machines, so don't leave it open to the internet if you can avoid it. Tailscale gives you a private address with HTTPS, so the app works as a PWA:

```sh
# in .env
TAILNET_PORT=3781
TAILNET_USERS=you@example.com
```

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3781
```

Only `tailscale serve` should reach that port. It sets the signed-in user on each request, and the gateway accepts no other login there. Then open `https://<machine>.<tailnet>.ts.net:8443`.

If a public host also points at the gateway, `PUBLIC_LANDING_ONLY=true` reduces that port to the landing page. Bots keep their local tool server.

If you serve the app from another address, list it in `ALLOWED_ORIGINS`. The gateway refuses WebSockets and changes that come from any other site.
