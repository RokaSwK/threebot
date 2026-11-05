import { useLayoutEffect, useRef } from "react";
import type { AvatarDefinition } from "open-bot-avatar";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { botColor, type AvatarState } from "../lib/character";
import { objectColors, objectMood } from "../lib/objectAvatars";
import { useApp } from "../store";

// A live object is hundreds of DOM nodes, so only hero sizes animate. Smaller ones are one SVG
// that still changes pose with its mood.
const LIVE_FROM = 56;

export function ObjectAvatar({ definition, color, size, state, still = false }: { definition: AvatarDefinition; color?: string; size: number; state: AvatarState; still?: boolean }) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const live = !still && size >= LIVE_FROM;
  const options = () => ({ definition, ...objectColors(host.current!, botColor(color)), mood: objectMood(state), still: !live, followPointer: live, label: "" });
  const latest = useRef(options);
  latest.current = options;

  useLayoutEffect(() => {
    const mounted = mountAvatar(host.current!, latest.current());
    avatar.current = mounted;
    return () => {
      mounted.destroy();
      avatar.current = null;
    };
  }, []);
  const theme = useApp((s) => s.settings?.theme);
  useLayoutEffect(() => { avatar.current?.update(latest.current()); }, [definition, color, state, live, theme]);

  return <span ref={host} className="block size-full" />;
}
