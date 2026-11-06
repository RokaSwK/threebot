# Bank accounts (Enable Banking)

Bots can connect bank accounts through [Enable Banking](https://enablebanking.com) and read balances and transactions. This is PSD2 account information only (AIS). There is no payment initiation: the code never calls a payment endpoint.

It is a Beta feature, off by default: **Settings → Beta → Bank accounts**. While it is off, the `banks_*` tools aren't listed or callable, `/banks/callback` answers 404, and the "Bank accounts" section is left out of every Bot's AGENTS.md. Switching it off deletes nothing.

## Why it isn't an Executor app

Executor accounts are OAuth or API keys. Enable Banking works differently. Each request carries an RS256 JWT signed with the application's own private key (`kid` = app id). Access to each bank comes from a consent session the user approves in the bank's app. Executor has no account type for either, so the integration lives beside the Vault: it shares the Vault's encryption key, its `request_secret` handoff and the gateway's `bot` MCP server.

## Setup

1. **Callback address.** Threebot needs a public https address that reaches the gateway. It is `$APP_URL/banks/callback`, for example `https://bot.swk.tools/banks/callback`. Set `ENABLE_BANKING_REDIRECT_URL` instead if the address is different. The route needs no Threebot sign-in, because the bank may send the user back to a phone browser that isn't signed in. The one-time `state` from `banks_connect` is what lets the request in. The route doesn't answer while the public port is in landing-only mode.
2. **Enable Banking control panel** (enablebanking.com → Applications → the app → Edit): add that address to the app's **Redirect URLs** and save. Without it, every bank sign-in fails at Enable Banking with a redirect error. An app can list several redirect URLs, so the Finance app's `https://finance.swk.tools/banks/callback` can stay. `banks_setup` reports whether the address is registered.
3. **Switch on** Settings → Beta → Bank accounts.
4. **Give a Bot the app.** Ask it to "set up Enable Banking". It asks for the application id in chat (not secret). It then asks for the private key through T3's secure card (`request_secret`, `delivery: "file"`): paste the whole `.pem`, line breaks or not. `banks_setup` checks the key against Enable Banking (`GET /application`), stores it encrypted and deletes T3's copy. The key never goes through chat, git or the Bot's context.
5. **Connect banks.** Ask the Bot to connect N26 or Trade Republic. It looks the bank up (`banks_find`, by country: banks such as N26 and Trade Republic are listed under several countries; the Finance app linked Trade Republic as ES), then sends a **Connect** link. Approve in the bank (Trade Republic: scan the QR code in its app; N26: log in), and you land on a Threebot page saying the bank is connected.

## Storage

One file, `BANKS_FILE` (default `$THREEBOT_HOME/banks.enc`, mode 600). It is AES-256-GCM encrypted with the Vault key (`VAULT_KEY_FILE`), with AAD `bot-banks:v1`. It holds the app id and private key, pending sign-ins (one use each, expire after an hour) and one session per bank and country. Back it up together with the Vault key.

Sessions are **shared by all Bots**, like the Vault. They belong to the user's accounts, not to any one Bot, and a per-Bot copy would mean approving each bank once per Bot within the same 90-day consent. Every read still needs a Bot's main `threadId`.

## What Bots see

| Tool | What it does |
|---|---|
| `banks_status` | Set up or not; each bank's accounts (`accountId`, name, currency, last 4 of the IBAN), `validUntil`, `daysLeft`, status `connected` / `reconnect-soon` (≤ 14 days) / `needs-reconnect` |
| `banks_find` | Banks for a country, by name |
| `banks_connect` | Starts a sign-in; returns the approval link |
| `banks_balances` | Balances of one account |
| `banks_transactions` | Transactions, newest first, following `continuation_key` (from 30 days ago by default, up to 1000) |
| `banks_setup` | Saves the app id and key from a `request_secret` file |
| `banks_disconnect` | Ends a bank's session here and at Enable Banking |

Bots never get the private key, session ids, full IBANs or counterparty IBANs. Balance and transaction reads are cached for 10 minutes, because PSD2 limits unattended reads to a few per account per day.

## Expiry and reconnecting

Consent lasts as long as the bank allows, at most 180 days and about 90 for N26. When it ends, the bank has to be approved again. `banks_status` flags each bank 14 days ahead. A read on a session the bank has ended or revoked marks that bank `needs-reconnect`. Calling `banks_connect` again for the same bank sends a new link, and once it's approved the new session replaces the old one (the old session is ended at Enable Banking). To get a reminder, ask a Bot for a routine that checks `banks_status`, for example weekly.

## Limits

- Trade Republic shares only its cash account: date, amount and direction, no merchant names, roughly the latest 100 transactions. N26 includes payee and reference.
- Holdings and securities are not in the Enable Banking feed.
- `ENABLE_BANKING_API_URL` overrides the API address (default `https://api.enablebanking.com`); sandbox apps use the same address.
