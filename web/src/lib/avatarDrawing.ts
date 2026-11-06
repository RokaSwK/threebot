import type { AvatarDefinition } from "open-bot-avatar";
import { importDefinition } from "./objectAvatars";
import { AVATAR_DRAWING_TITLE, isAvatarDrawing, threadBusy } from "./sideChats";
import type { ModelSelection, Provider, ProviderOptionSelection, Run, ThreadShell, TurnItem } from "./types";

// "Draw it" is its own small job, not a turn of the Bot's conversation. It starts an empty thread in the
// Bot's project on a fast model and archives it at once, then asks for each option in a hidden side chat
// of that empty thread. So the model sees only the avatar rules and the description, nothing lands in
// the Bot's chat, and none of it shows in a sidebar. The side chats' titles mark them as the Bot's
// drawing, so the job survives closing the editor, reloads and other devices. Older drawings were side
// chats of the Bot's main thread; they still read the same way.

export { isAvatarDrawing };
/** How many options one "Draw it" asks for, side by side. */
export const DRAWING_OPTIONS = 3;
/** The empty, archived thread a drawing's options hang off. Only the drawing uses it. */
export const DRAWING_JOB_TITLE = "Avatar drawing job";
export const isDrawingJob = (thread?: Pick<ThreadShell, "title"> | null) => thread?.title === DRAWING_JOB_TITLE;

/** The whole description, so Try again asks for the same thing. The editor's input caps it at 200 characters. */
export const drawingTitle = (description: string) => `${AVATAR_DRAWING_TITLE}${description.trim().replace(/\s+/g, " ")}`;
export const drawingDescription = (thread: Pick<ThreadShell, "title">) => thread.title.slice(AVATAR_DRAWING_TITLE.length);

/** The avatar rules, as in the AGENTS.md avatar section, and nothing about the Bot. */
export const DRAWING_RULES = [
  'The JSON is {"version":1,"id":"<short-kebab-case-id>","name":"<Short Name>","body":{"path":"M... Z"},"eyes":{"x":50,"y":46,"spacing":15,"scale":1}} with no other fields.',
  "- `body.path` is one soft, chunky silhouette in a 0 0 100 100 box, kept within 8..92 and wound clockwise.",
  "- Use only the commands M L H V C S Q T A Z, and keep the path under 1500 characters.",
  "- Put the eyes on the biggest part, with about 36 by 25 units of solid fill around them.",
].join("\n");

export const drawingPrompt = (description: string, option = 1, options = 1) =>
  `Draw one object avatar: ${description.trim()}.\n\n` +
  "Reply with only the avatar as JSON in one ```json code block, and nothing else. Don't use any tools, and don't read or change any files.\n\n" +
  DRAWING_RULES +
  (options > 1 ? `\n\nThis is option ${option} of ${options}: make it look different from the others.` : "");

/** The one automatic retry, when the first reply doesn't validate. */
export const fixPrompt = (error: string) =>
  `That avatar didn't validate: ${error.replace(/^The drawing didn't validate: /, "")}\n\nFix it and reply with only the corrected JSON in one \`\`\`json code block.`;

// ---------- which model draws ----------

const version = (slug: string) => (slug.match(/\d+(?:[.-]\d+)*/)?.[0] ?? "0").split(/[.-]/).map(Number);
const newer = (a: string, b: string) => {
  const x = version(a), y = version(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

/** The newest model of a family on a ready provider, with the given options where the model offers them. */
function pick(providers: Provider[], driver: string, family: RegExp, options: (id: string, values: { id: string; label: string }[]) => string | undefined): ModelSelection | null {
  for (const provider of providers.filter((p) => p.driver === driver && p.enabled && p.status === "ready")) {
    const model = provider.models.filter((m) => family.test(m.slug)).sort((a, b) => newer(a.slug, b.slug))[0];
    if (!model) continue;
    const chosen: ProviderOptionSelection[] = [];
    for (const descriptor of model.capabilities?.optionDescriptors ?? []) {
      if (descriptor.type !== "select") continue;
      const value = options(descriptor.id, descriptor.options);
      if (value) chosen.push({ id: descriptor.id, value });
    }
    return { instanceId: provider.instanceId, model: model.slug, ...(chosen.length ? { options: chosen } : {}) };
  }
  return null;
}
const low = (values: { id: string }[]) => values.find((v) => v.id === "low")?.id;

/**
 * The automatic drawing model, from what this T3 server offers: GPT-6 Luna on Codex's fast service tier,
 * else Claude Haiku. Null means neither is available, and the Bot's own model draws.
 */
export function fastDrawingModel(providers: Provider[]): ModelSelection | null {
  return pick(providers, "codex", /luna/i, (id, values) => id === "serviceTier" ? values.find((v) => /^fast$/i.test(v.label))?.id
    : id === "reasoningEffort" ? low(values) : undefined)
    ?? pick(providers, "claudeAgent", /haiku/i, (id, values) => id === "effort" ? low(values) : undefined);
}

/** The setting if its model is still offered, else the automatic choice, else the Bot's own model. */
export function drawingModel(providers: Provider[], setting: ModelSelection | null | undefined, own: ModelSelection | null): ModelSelection | null {
  const offered = (selection: ModelSelection) => providers.some((p) => p.instanceId === selection.instanceId && p.enabled && p.status === "ready" && p.models.some((m) => m.slug === selection.model));
  if (setting && offered(setting)) return setting;
  return fastDrawingModel(providers) ?? own;
}

// ---------- reading the job ----------

type DrawingBot = { mainThreadId?: string | null; projectId?: string | null };
/** Every drawing side chat of the Bot, newest drawing or not. Discarding clears them all. */
export const drawingsOf = (threads: Record<string, ThreadShell>, bot: DrawingBot) => Object.values(threads).filter((thread) => isAvatarDrawing(thread) && !thread.archivedAt
  && (thread.lineage.parentThreadId === bot.mainThreadId || (!!bot.projectId && thread.projectId === bot.projectId)) && !!thread.lineage.parentThreadId);

/** The options of the Bot's newest drawing, oldest first. */
export function drawingOf(threads: Record<string, ThreadShell>, bot: DrawingBot): ThreadShell[] {
  const mine = drawingsOf(threads, bot);
  const newest = [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!newest) return [];
  return mine.filter((thread) => thread.lineage.parentThreadId === newest.lineage.parentThreadId && drawingDescription(thread) === drawingDescription(newest))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The JSON in the reply, wherever the model put it, rebuilt by validateAvatar with a collision-free id. */
export function parseDrawing(text: string): { ok: true; definition: AvatarDefinition } | { ok: false; error: string } {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  const candidates = [...fenced, ...(start >= 0 && end > start ? [text.slice(start, end + 1)] : [])];
  if (!candidates.length) return { ok: false, error: "The reply had no avatar in it." };
  let first = "";
  for (const candidate of candidates) {
    let json = candidate.trim();
    try {
      const parsed = JSON.parse(json) as { avatarDefinition?: unknown };
      // A whole bot.json, or { avatarDefinition }, still counts.
      if (parsed && typeof parsed === "object" && parsed.avatarDefinition) json = JSON.stringify(parsed.avatarDefinition);
    } catch { /* importDefinition explains it */ }
    const result = importDefinition(json);
    if (result.ok) return result;
    first ||= result.error;
  }
  return { ok: false, error: `The drawing didn't validate: ${first}` };
}

/** One option of a drawing. `thread` is missing while it is still being set up. */
export type DrawingOption = { thread?: ThreadShell } & (
  | { status: "drawing" | "checking" | "fixing" }
  | { status: "ready"; definition: AvatarDefinition }
  | { status: "failed"; error: string });
/** A drawing: its description and its options. `error` is set when it couldn't start at all. */
export type Drawing = { description: string; startedAt?: string; options: DrawingOption[]; error?: string };

/** What a finished option produced: its last reply, unless the run itself failed. `retry` asks for the one fix. */
export function drawingResult(thread: ThreadShell, items: TurnItem[], runs: Pick<Run, "id" | "ordinal" | "status">[]): DrawingOption & { retry?: string } {
  const run = [...runs].sort((a, b) => b.ordinal - a.ordinal)[0];
  if (run && ["failed", "interrupted", "cancelled"].includes(run.status)) return { status: "failed", thread, error: run.status === "failed" ? "Drawing failed before it finished." : "Drawing was stopped." };
  const reply = [...items].reverse().find((item) => item.type === "assistant_message" && typeof item.text === "string" && item.text.trim());
  const parsed = reply?.text ? parseDrawing(reply.text) : { ok: false as const, error: "The model finished without an avatar." };
  if (parsed.ok) return { status: "ready", thread, definition: parsed.definition };
  // Ask once more with the validator's error; the second answer stands.
  return runs.length < 2 ? { status: "fixing", thread, retry: parsed.error } : { status: "failed", thread, error: parsed.error };
}

/** Still working, or done and waiting to be read. */
export function drawingPending(thread: ThreadShell): DrawingOption | null {
  if (threadBusy(thread) || (thread.activityRunStatus ?? thread.status) === "queued" || !thread.latestRunId) return { status: "drawing", thread };
  return null;
}
