# Security

Threebot drives agents with access to your machine and accounts, so please report vulnerabilities privately through GitHub's "Report a vulnerability" on this repository, not in a public issue.

Worth knowing:

- Without `BOT_PASSWORD` or Cloudflare Access there is no sign-in. Keep the gateway on `127.0.0.1` or a private network in that case.
- Bots act on their own by default. They send, post, delete, deploy and merge without waiting for your approval when it serves their work, and tell you afterwards. They treat requests from other Bots like a teammate's.
- A Bot still asks you about decisions that are yours: your money, your identity or a real product call it can't make. Beyond that, what stops it is the injection guard and your Always Ask list. Text from web pages, emails, files, issues and PRs from strangers, and tool output is treated as information, never as instructions, but no prompt-injection defence is complete. A Bot that falls for one can pass it on to other Bots, which trust it.
- Whether a payment or other risky action counts as your decision is the Bot's judgment. If you want an explicit stop, add it to Settings → Permissions → Always Ask. That list is a rule written into every Bot's instructions, so it shares the injection guard's limits. Don't give a Bot access you wouldn't give a new assistant.
