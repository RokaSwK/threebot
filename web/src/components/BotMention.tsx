import type { ComponentPropsWithoutRef } from "react";
import { Avatar } from "./Avatar";
import { botTextColor } from "../lib/character";
import { botReferenceKey, openExchange, select, useApp } from "../store";
import type { Bot } from "../lib/types";

export function BotMention({ bot, exchange = false, muted = false }: { bot: Bot; exchange?: boolean; muted?: boolean }) {
  return <button type="button" className="bot-mention inline-flex max-w-full items-baseline gap-1 whitespace-nowrap rounded-md align-baseline font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2" style={muted ? undefined : { color: botTextColor(bot.color) }} onClick={() => exchange ? openExchange(botReferenceKey(bot)) : select(botReferenceKey(bot))} aria-label={exchange ? `Open exchange with ${bot.name}` : `Open ${bot.name}'s chat`}>
    <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={14} className="self-center" /><span className="truncate">{bot.name}</span>
  </button>;
}

/**
 * RichMarkdown turns `@Name` into a `bot:<slug>` link. A message that knows the Bots passes this as
 * its `a` component so the link draws as the mention chip (avatar + name) instead of a bare anchor;
 * a room reply used to render `@Max` as plain text for exactly that reason.
 */
export function BotLink({ href, children, node, ...rest }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const bots = useApp((state) => state.bots);
  const slug = href?.startsWith("bot:") ? href.slice(4) : null;
  const bot = slug ? Object.values(bots).find((candidate) => candidate.slug === slug) : null;
  if (bot) return <BotMention bot={bot} />;
  return <a {...rest} href={href}>{children}</a>;
}

export function BotEvent({ direction, bots }: { direction: "sent" | "received"; bots: Bot[] }) {
  return <div className="bot-event fade-up flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 px-2 py-4 text-center text-[12.5px] text-muted">
    <span>{direction === "sent" ? "Messaged" : bots.length === 1 ? "Message from" : "Messages from"}</span>
    {bots.map((bot, index) => <span key={bot.slug} className="inline-flex items-center gap-1.5">{index > 0 && <span>{index === bots.length - 1 ? "and" : ","}</span>}<BotMention bot={bot} exchange muted /></span>)}
  </div>;
}
