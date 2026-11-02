import type { TurnItem } from "./types";

export function shortToolName(name: string) {
  return name.split(/__|\./).at(-1) ?? name;
}

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return null; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function resultObject(value: unknown): Record<string, unknown> | null {
  const result = object(value);
  if (!result || result.isError === true || result.error || result._tag === "OrchestratorMcpFailure") return null;
  const structured = object(result.structuredContent);
  if (structured) return structured;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      const text = object(block)?.text;
      const decoded = object(text);
      if (decoded) return decoded._tag === "OrchestratorMcpFailure" ? null : decoded;
    }
    return null;
  }
  return result;
}

export type BotDelivery = {
  id: string;
  itemId: string;
  senderThreadId: string;
  recipientThreadId: string;
  text: string;
  at: string;
  runId: string | null;
};

/** Only a successful runtime result proves a message was sent. */
export function botDelivery(item: TurnItem): BotDelivery | null {
  if (item.type !== "dynamic_tool" || item.status !== "completed" || shortToolName(String(item.toolName ?? "")) !== "t3_thread_send") return null;
  const input = object(item.input);
  const output = resultObject(item.output);
  if (!input || !output || typeof input.threadId !== "string" || typeof input.message !== "string" || output.threadId !== input.threadId) return null;
  return {
    id: typeof output.messageId === "string" ? output.messageId : item.id,
    itemId: item.id,
    senderThreadId: item.threadId,
    recipientThreadId: input.threadId,
    text: input.message,
    at: item.completedAt ?? item.updatedAt,
    runId: item.runId,
  };
}

export function stripSender(text: string) {
  return text.replace(/^From [^:\n]{1,80}:\s*/, "");
}

/** The exchange consists of actual Bot messages, never the summaries shown to the user. */
export function botExchange(items: TurnItem[], left: string, right: string): BotDelivery[] {
  const messages = new Map<string, BotDelivery>();
  const pair = (a: string, b: string) => (a === left && b === right) || (a === right && b === left);
  // Prefer the recipient's message: it retains the dispatch messageId and authoritative timestamp.
  for (const item of items) {
    if (item.type !== "user_message" || typeof item.senderThreadId !== "string" || typeof item.text !== "string" || !pair(item.senderThreadId, item.threadId)) continue;
    const id = typeof item.messageId === "string" ? item.messageId : item.id;
    messages.set(id, { id, itemId: item.id, senderThreadId: item.senderThreadId, recipientThreadId: item.threadId, text: stripSender(item.text), at: item.startedAt ?? item.updatedAt, runId: item.runId });
  }
  for (const item of items) {
    const delivery = botDelivery(item);
    if (delivery && pair(delivery.senderThreadId, delivery.recipientThreadId) && !messages.has(delivery.id)) messages.set(delivery.id, { ...delivery, text: stripSender(delivery.text) });
  }
  return [...messages.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export function parseThreadLink(href: string): { threadId: string; environmentId: string | null } | null {
  const match = /^t3-thread:\/\/(?:v1\/([^\s<>]+)|v2\/([^/\s]+)\/([^\s<>]+))$/.exec(href);
  if (!match) return null;
  try {
    return { threadId: decodeURIComponent(match[3] ?? match[1]), environmentId: match[2] ? decodeURIComponent(match[2]) : null };
  } catch { return null; }
}
