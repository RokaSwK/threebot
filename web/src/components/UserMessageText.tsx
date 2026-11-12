import { memo, useMemo } from "react";
import { mentionSegments } from "../../../server/mention-rules.mts";
import { BotMention } from "./BotMention";
import type { Bot } from "../lib/types";
import { useApp } from "../store";

/**
 * The text of a user's message with `@Bot` mentions drawn as the same chip the rest of the app
 * uses (avatar + name + colour). The user's text deliberately does not go through Markdown: it
 * keeps its literal formatting and only the mentions are replaced.
 */
export const UserMessageText = memo(function UserMessageText({ text, muted = false }: { text: string; muted?: boolean }) {
  const bots = useApp((s) => s.bots);
  // Only the names matter for parsing, and polling replaces the Bot objects even when the names
  // have not changed, so the key is built from names.
  const namesKey = useMemo(
    () => Object.values(bots).map((bot) => bot.name).filter((name) => name.trim() !== "").join("\u0000"),
    [bots]
  );
  const segments = useMemo(() => mentionSegments(text, namesKey === "" ? [] : namesKey.split("\u0000")), [text, namesKey]);

  if (!segments.some((segment) => segment.bot !== undefined)) return <>{text}</>;

  const byName = new Map<string, Bot>(Object.values(bots).map((bot) => [bot.name.toLowerCase(), bot]));
  return (
    <>
      {segments.map((segment, index) => {
        const bot = segment.bot === undefined ? undefined : byName.get(segment.bot.toLowerCase());
        return bot ? <BotMention key={`${index}:${bot.slug}`} bot={bot} muted={muted} /> : <span key={index}>{segment.text}</span>;
      })}
    </>
  );
});
