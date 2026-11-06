import { validateAvatar, type AvatarDefinition, type AvatarMotion } from "open-bot-avatar";
import gallery from "../../../server/object-avatars.json";
import type { AvatarState } from "./character";
import type { Bot } from "./types";

// Object looks from Open Bot Avatar. Definitions can come from agents, and the renderer writes
// them with innerHTML, so only validateAvatar's rebuilt output ever reaches it.
const PREFIX = "object:";
const checked = new WeakMap<object, AvatarDefinition | null>();

export const OBJECT_AVATARS = gallery as AvatarDefinition[];
const builtIn = new Map(OBJECT_AVATARS.map((definition) => [definition.id, definition]));

export const isObjectShape = (shape: string) => shape.startsWith(PREFIX);
export const objectShape = (id: string) => `${PREFIX}${id}`;

export function safeDefinition(value: unknown): AvatarDefinition | null {
  if (typeof value !== "object" || value === null) return null;
  if (!checked.has(value)) {
    const result = validateAvatar(value);
    checked.set(value, result.ok ? result.value : null);
  }
  return checked.get(value) ?? null;
}

type Owner = Pick<Bot, "shape" | "avatarDefinition">;
/** Gallery objects first, so a Bot's own file can't restyle another Bot's object. */
export function objectDefinition(shape: string, owners: Iterable<Owner>) {
  const id = shape.slice(PREFIX.length);
  const known = builtIn.get(id);
  if (known) return known;
  for (const owner of owners) {
    if (owner.shape !== shape) continue;
    const own = safeDefinition(owner.avatarDefinition);
    if (own?.id === id) return own;
  }
  return null;
}

/** Objects Bots have drawn for themselves, deduplicated, excluding the built-in gallery. */
export function sharedObjects(bots: Iterable<Owner>): AvatarDefinition[] {
  const found = new Map<string, AvatarDefinition>();
  for (const bot of bots) {
    if (!isObjectShape(bot.shape)) continue;
    const own = safeDefinition(bot.avatarDefinition);
    if (own && !builtIn.has(own.id) && !found.has(own.id) && bot.shape === objectShape(own.id)) found.set(own.id, own);
  }
  return [...found.values()];
}

/** Pasted JSON becomes a definition with its own id, or a sentence saying what's wrong. */
export function importDefinition(json: string): { ok: true; definition: AvatarDefinition } | { ok: false; error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { return { ok: false, error: "That isn't valid JSON." }; }
  const result = validateAvatar(parsed);
  if (!result.ok) return { ok: false, error: result.errors[0] };
  let hash = 0;
  for (const char of result.value.body.path) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return { ok: true, definition: { ...result.value, id: `own-${hash.toString(36)}` } };
}

const THINKING: AvatarState[] = ["thinking", "searching", "working", "listening", "loading", "dictating", "writing", "sending", "receiving", "uploading", "spawning", "waiting", "radar", "orbit", "progress"];
const HAPPY: AvatarState[] = ["happy", "excited", "celebrate", "proud", "laughing", "playful", "humming", "bouncing"];
/** The object renderer has three moods; the ball's full range of states stays on the ball. */
export function objectMood(state: AvatarState): AvatarMotion {
  return THINKING.includes(state) ? "thinking" : HAPPY.includes(state) ? "happy" : "idle";
}

/**
 * Hex colors for a still avatar. Live canvases take CSS colors since Open Bot Avatar 0.2, but stills
 * go through renderAvatarSvg, which only accepts hex, so CSS colors (and the eye cut-out) resolve here.
 */
export function objectColors(element: HTMLElement, css: string, eye: string) {
  const resolve = (value: string, fallback: string) => {
    element.style.color = value;
    const parts = getComputedStyle(element).color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
    return parts?.length === 3 ? `#${parts.map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}` : fallback;
  };
  return { color: resolve(css, css), eyeColor: resolve(eye, "#151515") };
}
