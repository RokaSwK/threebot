// Automations post into a Bot's thread as the user, marked only by creationSource "server" and a
// "From <name>:" prefix. They are briefs for the agent, so they shouldn't read as something you said.

export type AutomatedIssue = { id: string; title: string; level: "critical" | "warning" | "info"; state: string; detail: string };
export type AutomatedMessage = { from: string; summary: string; issues: AutomatedIssue[]; text: string };

const PREFIX = /^From ([^:\n]{1,60}):\s*/;
const EVENTS = /\s*Event summary:\s*(\[[\s\S]*\])\s*$/;
const STATES: Record<string, string> = { new: "New", persistent: "Ongoing", recovered: "Recovered", resolved: "Resolved", worsened: "Worse" };

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
const ACRONYMS = /\b(api|cpu|dns|gpu|http|https|ip|nas|ram|ssh|ssl|tls|url|vpn)\b/g;
const SEVERITY = { critical: 0, warning: 1, info: 2 };
const words = (code: string) => {
  const name = code.split(":")[0].replace(/[_-]+/g, " ").trim().replace(ACRONYMS, (word) => word.toUpperCase());
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : "Issue";
};

function issues(raw: string): AutomatedIssue[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  return parsed.flatMap((value, index): AutomatedIssue[] => {
    const row = record(value);
    if (!row || typeof row.code !== "string") return [];
    const level = row.level === "critical" || row.level === "warning" ? row.level : "info";
    const event = typeof row.event === "string" ? row.event : "";
    return [{ id: `${row.code}:${index}`, title: words(row.code), level, state: STATES[event] ?? (event ? words(event) : ""), detail: typeof row.message === "string" ? row.message : "" }];
  }).sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
}

const firstSentence = (text: string) => {
  const line = /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text;
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > 110 ? `${flat.slice(0, 109).trimEnd()}…` : flat;
};

/** Null for anything that isn't clearly an automation, so your own words stay plain bubbles. */
export function automatedMessage(item: Record<string, unknown>): AutomatedMessage | null {
  if (item.creationSource !== "server" || item.createdBy === "agent" || item.senderThreadId || typeof item.text !== "string") return null;
  const prefix = PREFIX.exec(item.text);
  if (!prefix) return null;
  const body = item.text.slice(prefix[0].length).trim();
  const events = EVENTS.exec(body);
  const parsed = events ? issues(events[1]) : null;
  const text = parsed ? body.slice(0, events!.index).trim() : body;
  return { from: prefix[1], summary: parsed?.length ? "Monitoring check" : firstSentence(text), issues: parsed ?? [], text };
}
