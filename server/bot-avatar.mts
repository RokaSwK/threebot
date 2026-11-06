import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parseHTML } from "linkedom";
import config from "./avatar-config.json" with { type: "json" };
import { cutoutEyes } from "./avatar-eyes.mts";
import { decorateT3Avatar } from "./avatar-t3.mts";
import { avatarImageFile } from "./avatar-images.mts";
import { Character } from "./character.mts";
import { objectDefinition, renderObjectIcon } from "./object-avatars.mts";

const colors: Record<string, string> = { ...config.colors, ...Object.fromEntries(config.pickerColors.filter(c => c.id !== "black").map(c => [c.id, c.value])) };

// The same engine as the web app, on a DOM with no animation loop. A fixed seed keeps
// the generated file stable across restarts.
const { document } = parseHTML("<!doctype html><html><body></body></html>");

// The fields a Bot's look is drawn from, as bot.json stores them. Unknown or invalid values fall back.
export interface AvatarBot { shape: string; color: string; avatarDefinition?: unknown }

const icons = new Map<string, string>();
export function renderBotAvatar(bot: AvatarBot): string {
  const object = objectDefinition(bot);
  if (object) {
    const fill = Object.hasOwn(colors, bot.color) ? colors[bot.color] : colors.teal;
    const key = `object:${object.body.path}:${JSON.stringify(object.eyes)}:${fill}`;
    if (!icons.has(key)) icons.set(key, renderObjectIcon(object, fill));
    return icons.get(key)!;
  }
  const special = config.specialShapes.find(avatar => avatar.id === bot.shape);
  const shape = special ? special.id : config.shapes.includes(bot.shape) || config.pickerShapes.includes(bot.shape) ? bot.shape : Object.hasOwn(config.shapeAliases, bot.shape) ? (config.shapeAliases as Record<string, string>)[bot.shape] : "blob";
  const fill = special ? colors[special.color] : Object.hasOwn(colors, bot.color) ? colors[bot.color] : colors.teal;
  const key = special ? shape : `${shape}:${fill}`;
  if (icons.has(key)) return icons.get(key)!;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  // Without this a browser won't draw the file as an image, and T3 falls back to initials.
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const character = new Character(svg, { shape: special ? "ball" : shape, state: "idle", inkFlat: fill, eyeColor: "#ffffff", sizePx: 64, paused: "hold-pose", random: () => 0.5 });
  if (special) decorateT3Avatar(svg, character.parts()).holdFrame();
  else cutoutEyes(svg, character.parts());
  character.destroy();
  // Regular silhouettes export literal body colors with transparent eye cutouts.
  if (!special) character.parts().body.setAttribute("fill", fill);
  if (!special && (bot.color === "white" || bot.color === "black")) {
    character.parts().body.setAttribute("stroke", "#959595");
    character.parts().body.setAttribute("stroke-width", "1.5");
  }
  const content = svg.outerHTML;
  icons.set(key, content);
  return content;
}

export async function ensureBotFavicon(bot: AvatarBot & { workspaceRoot: string; avatarImage?: unknown }) {
  const picture = avatarImageFile(bot.avatarImage);
  if (picture) return picture;
  const svg = renderBotAvatar(bot);
  const revision = createHash("sha256").update(svg).digest("hex").slice(0, 12);
  // T3 caches by faviconPath. Change the path when the appearance changes.
  const relativePath = `.bot/avatar-${revision}.svg`;
  const file = path.join(bot.workspaceRoot, relativePath);
  if (await readFile(file, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  }) !== svg) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, svg);
  }
  return relativePath;
}

interface ProjectClient { call(method: string, input: Record<string, unknown>): Promise<unknown> }
interface BotProject { id: string; title?: string; faviconPath?: string | null; projectIcon?: unknown }

export async function syncBotProject(client: ProjectClient, bot: AvatarBot & { workspaceRoot: string; avatarImage?: unknown; name: string }, project: BotProject) {
  const faviconPath = await ensureBotFavicon(bot);
  if (project.title === bot.name && project.faviconPath === faviconPath && project.projectIcon == null) return;
  await client.call("projects.mutate", {
    type: "project.update", commandId: randomUUID(), projectId: project.id,
    title: bot.name, faviconPath, projectIcon: null,
  });
}
