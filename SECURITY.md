# Security

Pingbot drives agents with access to your machine and accounts, so please report vulnerabilities privately through GitHub's "Report a vulnerability" on this repository, not in a public issue.

Worth knowing:

- Without `BOT_PASSWORD` or Cloudflare Access there is no sign-in. Keep the gateway on `127.0.0.1` or a private network in that case.
- Text from web pages, emails and files is treated as data, not instructions, but no prompt-injection defence is complete. Don't give a Bot access you wouldn't give a new assistant.
