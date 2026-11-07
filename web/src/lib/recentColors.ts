import { normalizeHex } from "../../../server/avatar-color.mts";

const RECENT_KEY = "bot.avatar.recentColors";
const RECENT_MAX = 8;

/** Custom colours this browser has saved on a Bot, newest first. */
export function recentColors(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.map(normalizeHex).filter((hex): hex is string => !!hex).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
/** Called when a custom colour is saved, not while it is being picked. */
export function rememberColor(hex: string) {
  const color = normalizeHex(hex);
  if (!color) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([color, ...recentColors().filter(c => c !== color)].slice(0, RECENT_MAX))); } catch {}
}

