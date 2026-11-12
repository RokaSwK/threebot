import { memo } from "react";
import clsx from "clsx";
import { Avatar } from "./Avatar";
import type { MentionBot } from "../lib/mentionMenu";

export interface MentionMenuProps {
  bots: MentionBot[];
  query: string;
  activeIndex: number;
  onPick: (bot: MentionBot) => void;
  onHover?: (index: number) => void;
  hint?: string;
}

export const MentionMenu = memo(function MentionMenu({
  bots,
  activeIndex,
  onPick,
  onHover,
  hint,
}: MentionMenuProps) {
  return (
    <div
      role="listbox"
      aria-label="Bot suggestions"
      className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[240px] overflow-y-auto rounded-2xl border border-line bg-card p-1.5 shadow-pop scroll-thin"
    >
      {bots.length === 0 ? (
        <div className="px-3 py-2 text-[13px] text-muted select-none" role="status">
          No Bots match
        </div>
      ) : (
        bots.map((bot, index) => {
          const active = index === activeIndex;
          return (
            <div
              key={bot.slug}
              role="option"
              aria-selected={active}
              aria-label={bot.name}
              onMouseEnter={() => onHover?.(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(bot);
              }}
              className={clsx(
                "flex cursor-pointer select-none items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[13px] transition-colors",
                active ? "bg-hover text-foreground" : "text-foreground hover:bg-hover"
              )}
            >
              <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={22} />
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate font-medium">{bot.name}</span>
                {bot.label && <span className="truncate text-[12px] text-muted">{bot.label}</span>}
              </div>
            </div>
          );
        })
      )}
      {hint && (
        <div className="mt-1 border-t border-line px-2.5 py-1 text-[11px] text-faint">
          {hint}
        </div>
      )}
    </div>
  );
});
