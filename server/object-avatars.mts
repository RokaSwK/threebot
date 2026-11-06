// Object looks for Bots, from Open Bot Avatar: an SVG silhouette plus eyes. `shape` is
// `object:<id>`, naming a gallery object or the Bot's own `avatarDefinition`. Definitions can be
// written by agents and reach innerHTML in the renderer, so nothing is used until it validates.
import { readFileSync } from "node:fs";
import { renderAvatarSvg, validateAvatar } from "open-bot-avatar";

export const OBJECT_PREFIX = "object:";
const gallery = new Map(JSON.parse(readFileSync(new URL("./object-avatars.json", import.meta.url), "utf8")).map((definition) => [definition.id, definition]));
export const OBJECT_AVATAR_IDS = [...gallery.keys()];

const isObject = (shape) => typeof shape === "string" && shape.startsWith(OBJECT_PREFIX);

export function objectDefinition(bot) {
  if (!isObject(bot?.shape)) return null;
  const id = bot.shape.slice(OBJECT_PREFIX.length);
  if (gallery.has(id)) return gallery.get(id);
  const own = bot.avatarDefinition ? validateAvatar(bot.avatarDefinition) : null;
  return own?.ok && own.value.id === id ? own.value : null;
}

/** Stores only a validated definition, and keeps `shape` pointing at it. */
export function objectAvatarPatch(patch) {
  if (patch.avatarDefinition) {
    const result = validateAvatar(patch.avatarDefinition);
    if (!result.ok) throw Object.assign(new Error(`Invalid avatar: ${result.errors[0]}`), { status: 400 });
    if (gallery.has(result.value.id)) throw Object.assign(new Error("Invalid avatar: that id belongs to a built-in object"), { status: 400 });
    return { ...patch, shape: `${OBJECT_PREFIX}${result.value.id}`, avatarDefinition: result.value };
  }
  return "shape" in patch || "avatarDefinition" in patch ? { ...patch, avatarDefinition: null } : patch;
}

export function objectEyeColor(hex) {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.16 ? "#ffffff" : "#151515";
}

export function renderObjectIcon(definition, fill) {
  return renderAvatarSvg(definition, { color: fill, eyeColor: objectEyeColor(fill), size: 64, time: 0, reducedMotion: true });
}
