import type { AvatarDefinition } from "open-bot-avatar";
import { importDefinition } from "./objectAvatars";
import { AVATAR_DRAWING_TITLE, isAvatarDrawing, threadBusy } from "./sideChats";
import type { Run, ThreadShell, TurnItem } from "./types";

// "Draw it" runs in a hidden side chat of the Bot's main conversation: the Bot keeps its own avatar
// rules (AGENTS.md) and context, but nothing lands in the main chat. The side chat's title marks it as
// the Bot's drawing job, so the job survives closing the editor, reloads and other devices.

export { isAvatarDrawing };
/** The whole description, so Try again asks for the same thing. The editor's input caps it at 200 characters. */
export const drawingTitle = (description: string) => `${AVATAR_DRAWING_TITLE}${description.trim().replace(/\s+/g, " ")}`;
export const drawingDescription = (thread: Pick<ThreadShell, "title">) => thread.title.slice(AVATAR_DRAWING_TITLE.length);

export const drawingPrompt = (description: string) =>
  `Draw a new object avatar for yourself: ${description.trim()}.\n\n` +
  "Follow the avatar drawing rules in your instructions (Identity): one `avatarDefinition` with a new unique id, a name, `body.path` and `eyes`, and no other fields. Check that it validates.\n\n" +
  "This is a draft to preview first. Don't edit `.bot/bot.json` or any other file, and don't change your current avatar. Reply with only the definition as JSON in one ```json code block.";

/** The newest drawing job for a conversation. */
export function drawingOf(threads: Record<string, ThreadShell>, mainThreadId: string | null | undefined) {
  if (!mainThreadId) return undefined;
  return Object.values(threads)
    .filter((thread) => isAvatarDrawing(thread) && thread.lineage.parentThreadId === mainThreadId && !thread.archivedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** The JSON in the reply, wherever the Bot put it, rebuilt by validateAvatar with a collision-free id. */
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

/** `thread` is missing while a drawing is still being set up, or when setting it up failed. */
export type Drawing = { thread?: ThreadShell; description: string } & (
  | { status: "drawing" | "checking" }
  | { status: "ready"; definition: AvatarDefinition }
  | { status: "failed"; error: string });

/** What the finished side chat produced: its last reply, unless the run itself failed. */
export function drawingResult(thread: ThreadShell, items: TurnItem[], runs: Pick<Run, "id" | "ordinal" | "status">[]): Drawing {
  const description = drawingDescription(thread);
  const run = [...runs].sort((a, b) => b.ordinal - a.ordinal)[0];
  if (run && ["failed", "interrupted", "cancelled"].includes(run.status)) return { status: "failed", thread, description, error: run.status === "failed" ? "Drawing failed before it finished." : "Drawing was stopped." };
  const reply = [...items].reverse().find((item) => item.type === "assistant_message" && typeof item.text === "string" && item.text.trim());
  if (!reply?.text) return { status: "failed", thread, description, error: "The Bot finished without an avatar." };
  const parsed = parseDrawing(reply.text);
  return parsed.ok ? { status: "ready", thread, description, definition: parsed.definition } : { status: "failed", thread, description, error: parsed.error };
}

/** Still working, or done and waiting to be read. */
export function drawingPending(thread: ThreadShell): Drawing | null {
  const description = drawingDescription(thread);
  if (threadBusy(thread) || (thread.activityRunStatus ?? thread.status) === "queued" || !thread.latestRunId) return { status: "drawing", thread, description };
  return null;
}
