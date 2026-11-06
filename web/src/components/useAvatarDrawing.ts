import { useEffect, useState } from "react";
import { drawingDescription, drawingOf, drawingPending, drawingPrompt, drawingResult, drawingTitle, type Drawing } from "../lib/avatarDrawing";
import { threadClient, threadTarget } from "../lib/t3";
import type { Bot, Run, TurnItem } from "../lib/types";
import { discardAvatarDrawing, startAvatarDrawing, useApp } from "../store";

// Read once per finished run, so reopening the editor doesn't ask T3 again.
const results = new Map<string, Drawing>();

/** The Bot's background drawing as the avatar editor shows it, and what the editor can do with it. */
export function useAvatarDrawing(bot: Bot) {
  const thread = useApp((s) => drawingOf(s.threads, bot.mainThreadId));
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState("");
  const [read, setRead] = useState<Drawing | null>(null);
  const pending = thread ? drawingPending(thread) : null;
  const key = thread && !pending ? `${thread.id}:${thread.latestRunId}:${thread.latestRunCompletedAt ?? ""}` : null;

  useEffect(() => {
    if (!thread || !key) { setRead(null); return; }
    const known = results.get(key);
    if (known) { setRead(known); return; }
    let live = true;
    setRead({ status: "checking", thread, description: drawingDescription(thread) });
    threadClient(thread.id).call<{ turnItems: TurnItem[]; runs?: Run[] }>("orchestration.getThreadProjection", { threadId: threadTarget(thread.id).threadId })
      .then((projection) => { const result = drawingResult(thread, projection.turnItems ?? [], projection.runs ?? []); results.set(key, result); return result; })
      .catch((): Drawing => ({ status: "failed", thread, description: drawingDescription(thread), error: "Couldn't read the drawing. Try again." }))
      .then((result) => { if (live) setRead(result); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const description = starting ?? (error ? failed : thread ? drawingDescription(thread) : "");
  let drawing: Drawing | null = null;
  // While the side chat is being set up there is nothing to stop yet, so it has no thread.
  if (error) drawing = { status: "failed", thread, description, error };
  else if (starting) drawing = { status: "drawing", description };
  else if (pending) drawing = pending;
  else if (thread && read?.thread?.id === thread.id) drawing = read;

  const start = async (text: string) => {
    text = text.trim();
    if (!text || starting) return;
    setStarting(text); setError("");
    try { await startAvatarDrawing(bot, drawingTitle(text), drawingPrompt(text)); }
    catch (cause) { setFailed(text); setError(cause instanceof Error ? cause.message : "Couldn't start the drawing"); }
    finally { setStarting(null); }
  };
  const discard = async () => {
    setError("");
    if (thread) await discardAvatarDrawing(thread.id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Couldn't discard the drawing"));
  };
  return { drawing, start, retry: () => void start(description), discard };
}
