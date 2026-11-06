import { useEffect, useMemo, useState } from "react";
import { drawingDescription, drawingOf, drawingsOf, drawingPending, type Drawing, type DrawingOption } from "../lib/avatarDrawing";
import type { Bot } from "../lib/types";
import { discardAvatarDrawing, readDrawingOption, startAvatarDrawing, useApp } from "../store";

/** The Bot's background drawing as the avatar editor shows it, and what the editor can do with it. */
export function useAvatarDrawing(bot: Bot) {
  const threads = useApp((s) => s.threads);
  const options = useMemo(() => drawingOf(threads, bot), [threads, bot]);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<{ description: string; message: string } | null>(null);
  const [read, setRead] = useState<Record<string, DrawingOption>>({});
  // One key per finished run of each option; reading it again is free (store caches it).
  const finished = options.filter((thread) => !drawingPending(thread)).map((thread) => `${thread.id}:${thread.latestRunId}:${thread.latestRunCompletedAt ?? ""}`).join("|");

  useEffect(() => {
    let live = true;
    for (const thread of options) {
      if (drawingPending(thread)) continue;
      const key = `${thread.id}:${thread.latestRunId}:${thread.latestRunCompletedAt ?? ""}`;
      setRead((all) => all[key] ? all : { ...all, [key]: { status: "checking", thread } });
      void readDrawingOption(thread).then((option) => { if (live) setRead((all) => ({ ...all, [key]: option })); });
    }
    return () => { live = false; };
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  let drawing: Drawing | null = null;
  if (error) drawing = { description: error.description, options: [], error: error.message };
  else if (starting) drawing = { description: starting, options: [] };
  else if (options.length) drawing = {
    description: drawingDescription(options[0]),
    startedAt: options[0].createdAt,
    options: options.map((thread): DrawingOption => drawingPending(thread) ?? read[`${thread.id}:${thread.latestRunId}:${thread.latestRunCompletedAt ?? ""}`] ?? { status: "checking", thread }),
  };

  const start = async (text: string) => {
    text = text.trim();
    if (!text || starting) return;
    setStarting(text); setError(null);
    try { await startAvatarDrawing(bot, text); }
    catch (cause) { setError({ description: text, message: cause instanceof Error ? cause.message : "Couldn't start the drawing" }); }
    finally { setStarting(null); }
  };
  const discard = async () => {
    setError(null);
    if (options.length) await discardAvatarDrawing(drawingsOf(useApp.getState().threads, bot)).catch((cause: unknown) => setError({ description: drawingDescription(options[0]), message: cause instanceof Error ? cause.message : "Couldn't discard the drawing" }));
  };
  return { drawing, start, retry: () => void start(drawing?.description ?? ""), discard };
}
