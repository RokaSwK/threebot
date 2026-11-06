# Privacy

Threebot runs on your own computer and keeps your Bots, chats, files and Vault there. The only thing it can send to the Threebot project is an anonymous usage-stats ping, and only if you turn it on.

## Usage stats

**Off by default.** Threebot asks once (new installs, and installs updating to the version that added stats). The box is unticked, and closing the question counts as no. Change it any time in **Settings → Usage stats**, which also shows the exact JSON of the next ping (**See what's sent**) and when the last one went out.

**Forced off** when the computer running Threebot sets `DO_NOT_TRACK=1` or `THREEBOT_TELEMETRY=0`, whatever the setting says.

When on, the Threebot gateway (not your browser) sends at most one ping a day. If it fails, it waits until the next day; it never slows down or blocks Threebot.

### What a ping contains

| Field | Example | What it is |
|---|---|---|
| `schema` | `1` | Ping format version |
| `installId` | `3f6c2a51-…` | A random ID made on your computer. Not derived from your hostname, user or IP. **Reset** in Settings makes a new one. |
| `threebot` | `0.1.5` | Threebot version |
| `t3code` | `0.1.7` | T3 Code version (or `null` if T3 Code didn't answer) |
| `node` | `22.18.0` | Node version |
| `os`, `arch` | `linux`, `arm64` | Operating system and processor type |
| `bots` | `2-5` | How many Bots, as a range: `0`, `1`, `2-5`, `6-10`, `11+` |
| `routines` | `1` | How many routines your Bots have, same ranges |
| `features` | `{ "projects": true, "autoUpdate": false, "freshSessionRoutines": false }` | Whether the Projects board (beta), Update automatically, and fresh-session routines are on |
| `tokens` | `{ "claude-opus-5-5": { "turns": 12, "inputTokens": 480000, "cachedInputTokens": 410000, "cacheCreationTokens": 20000, "outputTokens": 9000 } }` | Tokens your Bots' threads used since the last ping, per model id, as T3 Code counted them. Left out when your T3 Code doesn't report token usage (before 0.1.5). |

A full example:

```json
{
  "schema": 1,
  "installId": "3f6c2a51-8d1e-4b7a-9c0f-2e5d7a1b4c93",
  "threebot": "0.1.5",
  "t3code": "0.1.7",
  "node": "22.18.0",
  "os": "linux",
  "arch": "arm64",
  "bots": "2-5",
  "routines": "1",
  "features": { "projects": true, "autoUpdate": true, "freshSessionRoutines": false },
  "tokens": {
    "claude-opus-5-5": { "turns": 12, "inputTokens": 480000, "cachedInputTokens": 410000, "cacheCreationTokens": 20000, "outputTokens": 9000 }
  }
}
```

### Never sent

Messages, prompts or replies, thread or routine titles, Bot names, file names or paths, Vault items, connected apps or accounts, project names, hostnames, usernames, emails, IP addresses, or anything typed into Threebot. Version strings and model ids that don't look like versions or ids are replaced with `other` before sending.

### Where it goes

To a small collector in this repository ([`telemetry/`](telemetry)): a Cloudflare Worker that checks every ping against the format above, drops any other field, keeps one ping per install ID per day, and stores no IP addresses or request headers. Pings are kept for at most 400 days.
