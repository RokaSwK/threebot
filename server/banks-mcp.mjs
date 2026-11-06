// Bank accounts (Enable Banking) as tools on the Bots' own MCP server ("bot"). Read-only: Bots can
// start a bank sign-in, then read balances and transactions. They never see the app key, session
// ids or full IBANs.

const threadIdProp = { type: "string", description: "Your main conversation's T3 thread id (in AGENTS.md, or mainThreadId in .bot/bot.json)." };

export const BANK_TOOLS = [
  {
    name: "banks_status",
    title: "Bank connections",
    description:
      "Whether Enable Banking is set up, and each connected bank with its accounts (accountId, name, currency, last 4 of the IBAN), when access ends (validUntil, daysLeft) and status: connected, reconnect-soon (14 days or less) or needs-reconnect. Start here before reading balances or transactions.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "banks_find",
    title: "Find a bank",
    description: "Banks Enable Banking can connect in a country (two-letter code, e.g. DE, ES), filtered by name. Use the exact bank name and country it returns with banks_connect.",
    inputSchema: { type: "object", properties: { country: { type: "string" }, search: { type: "string", description: "Part of the bank's name, e.g. \"N26\" or \"Trade Republic\"." } }, required: ["country"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "banks_connect",
    title: "Connect or reconnect a bank",
    description:
      "Start a read-only connection to a bank (balances and transactions; never payments). Returns the bank's approval link: send it to the user on its own line as [Connect <bank>](<url>). They approve in their bank's app or website and land back on Threebot, which saves the connection. Reconnecting a bank replaces its old connection. The link works once, for an hour.",
    inputSchema: {
      type: "object",
      properties: { bank: { type: "string", description: "The bank's name as banks_find lists it." }, country: { type: "string", description: "Two-letter country code as banks_find lists it." }, threadId: threadIdProp },
      required: ["bank", "country", "threadId"],
    },
  },
  {
    name: "banks_balances",
    title: "Read account balances",
    description: "Current balances of a connected account (accountId from banks_status). Results are cached for 10 minutes because banks limit background reads to a few a day.",
    inputSchema: { type: "object", properties: { accountId: { type: "string" }, threadId: threadIdProp }, required: ["accountId", "threadId"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "banks_transactions",
    title: "Read account transactions",
    description:
      "Transactions of a connected account, newest first: date, signed amount (negative = money out), currency, status, counterparty and description when the bank provides them. dateFrom defaults to 30 days ago. Cached for 10 minutes. Some banks give less: Trade Republic only shares its cash account and roughly its latest 100 transactions, without merchant names; holdings aren't available through any bank.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        dateFrom: { type: "string", description: "YYYY-MM-DD" },
        dateTo: { type: "string", description: "YYYY-MM-DD" },
        limit: { type: "number", description: "At most this many (default 100, up to 1000)." },
        threadId: threadIdProp,
      },
      required: ["accountId", "threadId"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "banks_setup",
    title: "Set up Enable Banking",
    description:
      "Save the Enable Banking application (its id and private key) so Bots can connect banks. Ask for the key with T3's request_secret (delivery \"file\", label \"Enable Banking private key (.pem)\") and pass the file here without reading it; it is checked with Enable Banking, encrypted next to the Vault and the file is deleted. Says whether Threebot's callback address is registered for the app.",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", description: "The application id from the Enable Banking control panel (not secret)." },
        secretFile: { type: "string", description: "The file request_secret returned." },
        redirectUrl: { type: "string", description: "Only if the callback isn't APP_URL/banks/callback: the https address registered in Enable Banking that reaches this gateway's /banks/callback." },
        threadId: threadIdProp,
      },
      required: ["appId", "secretFile", "threadId"],
    },
  },
  {
    name: "banks_disconnect",
    title: "Disconnect a bank",
    description: "End a bank's access, here and at Enable Banking. Only when the user asks.",
    inputSchema: { type: "object", properties: { connectionId: { type: "string" }, threadId: threadIdProp }, required: ["connectionId", "threadId"] },
    annotations: { destructiveHint: true },
  },
];

const toolJson = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });

export function createBankTools({ banks, log = () => {} }) {
  return async function callBankTool(name, args = {}, { botFor, readSecret } = {}) {
    try {
      switch (name) {
        case "banks_status": {
          const status = await banks.status();
          const notes = [];
          if (!status.configured) notes.push("Enable Banking isn't set up. Ask the user for the app id, then the private key with request_secret (delivery \"file\"), and call banks_setup.");
          for (const c of status.connections) {
            if (c.status === "needs-reconnect") notes.push(`${c.bank} needs reconnecting: call banks_connect and send the link.`);
            else if (c.status === "reconnect-soon") notes.push(`${c.bank} access ends in ${c.daysLeft} days; offer to reconnect it now.`);
          }
          return toolJson({ ...status, ...(notes.length ? { notes } : {}) });
        }
        case "banks_find":
          return toolJson({ banks: await banks.findBanks(args) });
        case "banks_connect": {
          const bot = await botFor(args.threadId);
          const link = await banks.connect({ bank: args.bank, country: args.country, startedBy: bot.slug });
          return toolJson({ ...link, send: `[Connect ${link.bank}](${link.url})`, next: "Send the link. When the user says they approved, call banks_status to confirm the accounts arrived." });
        }
        case "banks_balances":
          await botFor(args.threadId);
          return toolJson(await banks.balances(args));
        case "banks_transactions":
          await botFor(args.threadId);
          return toolJson(await banks.transactions(args));
        case "banks_setup": {
          const bot = await botFor(args.threadId);
          if (!readSecret) return toolError("Saving secrets isn't set up on this server.");
          const secret = await readSecret(args.secretFile);
          const result = await banks.setup({ appId: args.appId, privateKey: secret.value, redirectUrl: args.redirectUrl });
          await secret.remove();
          log(`banks: ${bot.slug} set up Enable Banking`);
          const notes = [];
          if (!result.redirectUrl) notes.push("No callback address yet: set APP_URL on the gateway (or pass redirectUrl) before connecting a bank.");
          else if (result.redirectRegistered === false) notes.push(`Ask the user to add ${result.redirectUrl} to the app's redirect URLs in the Enable Banking control panel (enablebanking.com → Applications → this app → Edit), or bank sign-ins will fail.`);
          return toolJson({ ...result, ...(notes.length ? { notes } : {}) });
        }
        case "banks_disconnect": {
          await botFor(args.threadId);
          return toolJson(await banks.disconnect(args));
        }
        default:
          return toolError(`Unknown tool ${name}`);
      }
    } catch (error) {
      // Errors from banks.mjs are written to be shown; they never contain the key or session ids.
      return toolError(String(error?.message ?? error));
    }
  };
}
