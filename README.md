<p align="center"><img src="docs/assets/treebot.png" width="128" alt="The Treebot ball" /></p>

<h1 align="center">Treebot</h1>

<p align="center"><b>Your Bot is a T3 thread.</b><br />Personal agents on T3 Code, on your own subscriptions.</p>

![A Bot on the phone, between its own eyes](docs/assets/hero.webp)

You already have [T3 Code](https://github.com/pingdotgg/t3code) and the Claude or Codex plan behind it. Treebot turns one long-lived T3 thread into someone you can message: a Bot. It keeps its own memory and routines, it starts and steers your other threads, and it brings you a short answer on your phone.

A morning with a Bot looks like this:

- A routine reads your overnight feedback at 8:00.
- It starts a real T3 thread for each bug, groups the duplicates and drafts the replies.
- It pings you: three fixed, twelve duplicates, forty replies ready. Send them?

Nothing new to pay for. Treebot doesn't resell AI; your Bots use the subscriptions T3 Code already has.

## What's in it

**On top of T3 Code**

| In Treebot | In T3 Code |
|---|---|
| A Bot | A long-lived thread in its own project |
| Subagents | T3 subagents and delegated threads |
| Routines | Scheduled tasks |
| A Bot's computer | The T3 browser, with Take control |
| The model in Bot details | Your T3 providers |

Everything stays a normal T3 thread, so you can open any of it in T3 Code at any time.

**Added by Treebot**

- **A messaging app.** An installable PWA built for phones, with notifications, search and themes.
- **Memory.** Each Bot keeps its own notes, plus facts shared by all your Bots.
- **Vault.** Encrypted logins Bots can type into a site without reading the password.
- **Connected apps.** Gmail, GitHub, Slack and the rest through [Executor](https://executor.sh), if you run it.
- **Approvals.** A Bot asks first before anything that leaves your machine or can't be undone.
- **A face.** The ball's weather tells you what it's doing: storms, aurora, a moon when it's asleep.

## Run it

You need Node 22.13 or newer and T3 Code running on the same machine.

```sh
git clone https://github.com/RokaSwK/treebot.git
cd treebot
npm run setup

cp .env.example .env
t3 auth session issue --ttl 30d --label treebot --token-only   # paste into T3_TOKEN
npm start
```

Open <http://127.0.0.1:3780> and create your first Bot. If T3 Code isn't on port 3773, set `T3_URL` in `.env`.

Treebot listens on `127.0.0.1` by default, with no sign-in. Before exposing it to other devices, read [docs/self-hosting.md](docs/self-hosting.md).

## How it works

The browser app talks only to a small Node gateway, and the gateway talks to T3 Code. There is no database: a Bot is a folder with its config, memory and library, plus a T3 project and thread. See [docs/architecture.md](docs/architecture.md).

```sh
npm run check   # web tests, build, server tests, fixture and asset checks
```

## Status

Early, and built around one person's daily use. It tracks T3 Code Nightly, whose API still moves, so expect things to break after a T3 update. Issues and pull requests are welcome.

Treebot is an independent project, not affiliated with or endorsed by T3 Tools Inc. MIT licensed; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
