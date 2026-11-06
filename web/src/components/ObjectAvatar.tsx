import { useLayoutEffect, useRef } from "react";
import type { AvatarDefinition } from "open-bot-avatar";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { botColor, type AvatarState } from "../lib/character";
import { objectColors, objectMood } from "../lib/objectAvatars";
import { useApp } from "../store";

// A live object is one canvas (Open Bot Avatar 0.2's default renderer) that pauses offscreen and runs
// at 30 fps when small. Only roster and hero sizes animate; list sizes stay one SVG that still
// changes pose with its mood.
const LIVE_FROM = 56;
const EYE = "var(--bot-eye-bg, var(--bg-chat))";

export function ObjectAvatar({ definition, color, size, state, still = false }: { definition: AvatarDefinition; color?: string; size: number; state: AvatarState; still?: boolean }) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const live = !still && size >= LIVE_FROM;
  // A live canvas reads CSS colors itself every frame, so it follows the theme. A still one is an SVG
  // string that needs hex, resolved against the current theme.
  const colors = () => live ? { color: botColor(color), eyeColor: EYE } : objectColors(host.current!, botColor(color), EYE);
  const options = () => ({ definition, ...colors(), mood: objectMood(state), still: !live, followPointer: live, label: "" });
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
  const palette = useApp((s) => s.settings?.palette);
  useLayoutEffect(() => {
    avatar.current?.update(latest.current());
    // The theme class changes in App's effect, after this one: resolve stills again once it has.
    const frame = requestAnimationFrame(() => avatar.current?.update(latest.current()));
    return () => cancelAnimationFrame(frame);
  }, [definition, color, state, live, theme, palette]);

  return <span ref={host} className="block size-full" />;
}
