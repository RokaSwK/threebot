import config from "../../../server/avatar-config.json";
import { cutoutEyes } from "../../../server/avatar-eyes.mjs";
import { decorateT3Avatar } from "../../../server/avatar-t3.mjs";
import { Character as Engine } from "../../../server/character.mjs";

export type AppAvatarState = "idle" | "working" | "thinking" | "waiting" | "sleeping" | "happy" | "failed";
export type AvatarState = keyof typeof config.states;
export const SHAPE_NAMES = config.shapes;
export const SPECIAL_AVATARS = config.specialShapes;
export const PICKER_SHAPES = config.pickerShapes;
export const PICKER_COLORS = config.pickerColors;
export const DEFAULT_AVATAR = config.defaultAvatar;
export const COLORS: Record<string, string> = { ...config.colors, ...Object.fromEntries(PICKER_COLORS.filter(c => c.id !== "black").map(c => [c.id, c.value])) };
export const COLOR_NAMES = Object.keys(COLORS);
const shapeAliases: Record<string, string> = config.shapeAliases;

export function avatarShape(name: string) {
  return SHAPE_NAMES.includes(name) || PICKER_SHAPES.includes(name) ? name : Object.hasOwn(shapeAliases, name) ? shapeAliases[name] : "blob";
}

export function botColor(name: string | undefined) {
  if (name === "black") return "light-dark(#000000, #FFFFFF)";
  return name && Object.hasOwn(COLORS, name) ? COLORS[name] : COLORS.teal;
}

interface Character {
  overlay: { x: number };
  setState(state: string, options?: { resetEyes: boolean }): void;
  setShape(shape: string): void;
  setInk(color: string): void;
  setSize(size: number): void;
  setGazeTarget(point: { x: number; y: number } | null): void;
  step(seconds: number): void;
  holdFrame(): void;
  parts(): { body: SVGPathElement; eyes: SVGPathElement[] };
  destroy(): void;
}

export function createCharacter(svg: SVGSVGElement, props: { shape: string; state: AvatarState; fill: string; size: number }): Character {
  const t3 = props.shape === "t3";
  const character: Character = new Engine(svg, {
    shape: t3 ? "ball" : avatarShape(props.shape), state: config.states[props.state], inkFlat: t3 ? COLORS.purple : props.fill,
    eyeColor: t3 ? "#ffffff" : "var(--bot-eye-bg, var(--bg-chat))", sizePx: props.size,
  });
  if (t3) {
    const skin = decorateT3Avatar(svg, character.parts());
    skin.setState(config.states[props.state]);
    skin.setSize(props.size);
    return {
      setState(state, options) { character.setState(state, options); skin.setState(state); },
      // Special editions own their silhouette and palette. AvatarPlayer rebuilds
      // the character when entering or leaving a special edition.
      setShape() {},
      setInk() {},
      setSize(size) { character.setSize(size); skin.setSize(size); },
      setGazeTarget(point) { skin.setGazeTarget(point); },
      step(seconds) { character.setGazeTarget(skin.eyeTarget()); character.step(seconds); skin.setFold(character.overlay.x); skin.step(seconds); },
      holdFrame() { character.holdFrame(); skin.holdFrame(); },
      overlay: character.overlay,
      parts: character.parts.bind(character),
      destroy: character.destroy.bind(character),
    };
  }
  cutoutEyes(svg, character.parts());
  if (props.fill === COLORS.white) {
    character.parts().body.setAttribute("stroke", "var(--border-strong)");
    character.parts().body.setAttribute("stroke-width", "1");
  }
  return character;
}

export const characterState = (state: AvatarState) => config.states[state];
