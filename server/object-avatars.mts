// Object looks for Bots, from Open Bot Avatar: an SVG silhouette plus eyes. `shape` is
// `object:<id>`, naming a gallery object or the Bot's own `avatarDefinition`. Definitions can be
// written by agents and reach innerHTML in the renderer, so nothing is used until it validates.
import { readFileSync } from "node:fs";
import { contrast } from "./avatar-color.mts";
import { renderAvatarSvg, validateAvatar, type AvatarDefinition } from "open-bot-avatar";

export const OBJECT_PREFIX = "object:";
const gallery = new Map<string, AvatarDefinition>(JSON.parse(readFileSync(new URL("./object-avatars.json", import.meta.url), "utf8")).map((definition: AvatarDefinition) => [definition.id, definition]));
export const OBJECT_AVATAR_IDS = [...gallery.keys()];

const isObject = (shape: unknown): shape is string => typeof shape === "string" && shape.startsWith(OBJECT_PREFIX);

export function objectDefinition(bot: { shape?: unknown; avatarDefinition?: unknown } | null | undefined) {
  if (!isObject(bot?.shape)) return null;
  const id = bot.shape.slice(OBJECT_PREFIX.length);
  if (gallery.has(id)) return gallery.get(id);
  const own = bot.avatarDefinition ? validateAvatar(bot.avatarDefinition) : null;
  return own?.ok && own.value.id === id ? own.value : null;
}

// Either `patch` itself (no look fields), or a copy with a validated or cleared definition.
type ObjectAvatarPatch<T> = T & { shape?: unknown; avatarDefinition?: AvatarDefinition | null };

/** Stores only a validated definition, and keeps `shape` pointing at it. */
export function objectAvatarPatch<T extends { shape?: unknown; avatarDefinition?: unknown; [key: string]: unknown }>(patch: T): ObjectAvatarPatch<T> {
  if (patch.avatarDefinition) {
    const result = validateAvatar(patch.avatarDefinition);
    if (!result.ok) throw Object.assign(new Error(`Invalid avatar: ${result.errors[0]}`), { status: 400 });
    if (gallery.has(result.value.id)) throw Object.assign(new Error("Invalid avatar: that id belongs to a built-in object"), { status: 400 });
    return { ...patch, shape: `${OBJECT_PREFIX}${result.value.id}`, avatarDefinition: result.value };
  }
  return "shape" in patch || "avatarDefinition" in patch ? { ...patch, avatarDefinition: null } : patch as ObjectAvatarPatch<T>;
}

/** Painted eyes on an object: white or near-black, whichever contrasts more with the body. */
export function objectEyeColor(hex: string) {
  return contrast("#ffffff", hex) > contrast("#151515", hex) ? "#ffffff" : "#151515";
}

export function renderObjectIcon(definition: AvatarDefinition, fill: string) {
  return renderAvatarSvg(definition, { color: fill, eyeColor: objectEyeColor(fill), size: 64, time: 0, reducedMotion: true });
}
