# Self-hosting

Treebot is one Node process next to a T3 Code server. It keeps everything in `TREEBOT_HOME` (default `~/.treebot`).

## Keep a Bot running

Bots only run while T3 Code and the gateway do, so run both as services on a machine that stays on. A systemd user unit for the gateway:

```ini
[Unit]
Description=Treebot

[Service]
WorkingDirectory=%h/treebot
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

Back up `TREEBOT_HOME`. It holds your Bots, memory and the encrypted Vault. `vault.enc` is useless without `.vault-key`, so keep the key somewhere separate and safe.

## Updating

```sh
git pull
npm run setup
```

Then restart the gateway. Treebot tracks T3 Code Nightly, so update both together.
