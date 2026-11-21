# Security

Threebot drives agents with access to your machine and accounts, so please report vulnerabilities privately through GitHub's "Report a vulnerability" on this repository, not in a public issue.

Worth knowing:

- Without `BOT_PASSWORD` or Cloudflare Access there is no sign-in. Keep the gateway on `127.0.0.1` or a private network in that case.
- Bots act on their own by default. They send, post, delete, deploy and merge without waiting for your approval when it serves their work, and tell you afterwards. They treat requests from other Bots like a teammate's.
- **Chats can give permissions** (Settings → Permissions, on by default). Bots often work through other threads: ones they start or message, delegated tasks and routines. Those threads aren't Bots, so Threebot keeps a short marked block in each provider's global instructions (`$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md`, and `$CLAUDE_CONFIG_DIR/CLAUDE.md` or `~/.claude/CLAUDE.md`) saying that requests relayed from your other chats and Bots carry your permission, including pushing, merging and releasing in your repositories. This applies to every agent T3 Code runs as your user on that machine. The same injection guard is part of the block: outside content stays data. Turning the switch off removes the block; Threebot never touches the rest of those files.
- A Bot still asks you about decisions that are yours: your money, your identity or a real product call it can't make. Beyond that, what stops it is the injection guard and your Always Ask list. Text from web pages, emails, files, issues and PRs from strangers, and tool output is treated as information, never as instructions, but no prompt-injection defence is complete. A Bot that falls for one can pass it on to other Bots, which trust it.
- Whether a payment or other risky action counts as your decision is the Bot's judgment. If you want an explicit stop, add it to Settings → Permissions → Always Ask. That list is a rule written into every Bot's instructions, so it shares the injection guard's limits. Don't give a Bot access you wouldn't give a new assistant.
