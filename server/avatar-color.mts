// A Bot's `color` is a palette name ("teal") or a custom "#rrggbb". Everything that draws a Bot
// resolves it here, and derives the colours that keep a face readable on any fill: an outline when
// the fill sits too close to the page, painted eyes when cut-out eyes would vanish into it, and
// overlay/text ink that stays visible. Shared by the web app and the gateway.
import config from "./avatar-config.json" with { type: "json" };

export type Rgb = [number, number, number];

/** Palette names with their fills. Picker ids (yellow, violet...) sit beside the older names. */
export const NAMED_COLORS: Record<string, string> = { ...config.colors, ...Object.fromEntries(config.pickerColors.filter(c => c.id !== "black").map(c => [c.id, c.value])) };
export const DEFAULT_COLOR = "teal";
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#rgb", "#rrggbb" (with or without "#", any case) as lowercase "#rrggbb", or null. */
export function normalizeHex(value: unknown): string | null {
  const match = typeof value === "string" ? HEX.exec(value.trim()) : null;
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map(d => d + d).join("") : match[1];
  return `#${digits.toLowerCase()}`;
}

export const isNamedColor = (value: unknown): value is string => typeof value === "string" && Object.hasOwn(NAMED_COLORS, value);
/** What bot.json may hold: a palette name or "#rrggbb". */
export const isAvatarColor = (value: unknown): value is string => isNamedColor(value) || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));

/** A custom colour: "#rrggbb" (any case, or "#rgb") rather than a palette name. */
export const isCustomColor = (value: unknown): value is string => !isNamedColor(value) && typeof value === "string" && value.startsWith("#") && !!normalizeHex(value);

/** The colour a request asks to store: a name as is, any hex spelling as "#rrggbb". Throws a 400 otherwise. */
export function avatarColorPatch(value: unknown): string {
  if (isNamedColor(value)) return value;
  const hex = normalizeHex(value);
  if (hex && typeof value === "string" && value.trim().startsWith("#")) return hex;
  throw Object.assign(new Error(`Invalid colour: use one of ${Object.keys(NAMED_COLORS).join(", ")}, or a hex colour like #3fa7d6`), { status: 400 });
}

/** The fill for a stored colour. Anything unknown falls back to teal, as it always has. */
export function colorHex(value: unknown): string {
  if (isNamedColor(value)) return NAMED_COLORS[value];
  return (typeof value === "string" && value.startsWith("#") && normalizeHex(value)) || NAMED_COLORS[DEFAULT_COLOR];
}

export const parseHex = (hex: string): Rgb => { const h = normalizeHex(hex) ?? "#000000"; return [1, 3, 5].map(i => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb; };
export const toHex = (rgb: Rgb) => `#${rgb.map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t) as Rgb;

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string) {
  const [r, g, b] = parseHex(hex).map(c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Typical page colours behind a Bot in each theme: the app's light canvas and dark canvas. */
export const SURFACES = { light: "#f9f8fd", dark: "#16141f" } as const;
export type Theme = keyof typeof SURFACES;
/** Below this a fill blends into the page. Every palette colour except white clears it. */
export const READABLE = 1.6;
const EDGE = 2.4;

/** The fill pushed toward black (light theme) or white (dark theme) until it stands off the page. */
function standOff(fill: string, theme: Theme, target: number) {
  const base = parseHex(fill), toward: Rgb = theme === "light" ? [16, 16, 24] : [255, 255, 255];
  for (let t = 0.1; t < 1; t += 0.05) {
    const candidate = toHex(mix(base, toward, t));
    if (contrast(candidate, SURFACES[theme]) >= target) return candidate;
  }
  return toHex(toward);
}

/** Painted eyes: a near-black or near-white ink tinted with the fill, whichever reads better on it. */
export function eyeInk(fill: string) {
  const base = parseHex(fill);
  const dark = toHex(mix(base, [12, 12, 18], 0.86)), light = toHex(mix(base, [255, 255, 255], 0.9));
  return contrast(dark, fill) >= contrast(light, fill) ? dark : light;
}

export interface ThemeInk {
  /** An outline for the body, or null when the fill already stands off the page. */
  edge: string | null;
  /** Painted eye colour, or null when eyes cut out of the body (showing the page) read fine. */
  eye: string | null;
  /** Thinking dots, rings and names: the fill, or its outline when the fill would vanish. */
  ink: string;
}

/** How a fill stays readable on each theme's page. */
export function avatarInk(fill: string): Record<Theme, ThemeInk> {
  const hex = normalizeHex(fill) ?? NAMED_COLORS[DEFAULT_COLOR];
  const theme = (name: Theme): ThemeInk => {
    if (contrast(hex, SURFACES[name]) >= READABLE) return { edge: null, eye: null, ink: hex };
    const edge = standOff(hex, name, EDGE);
    return { edge, eye: eyeInk(hex), ink: edge };
  };
  return { light: theme("light"), dark: theme("dark") };
}

/** Text in a Bot's colour (its name in a mention) that stays readable on the page. */
export function textInk(fill: string, theme: Theme) {
  const hex = normalizeHex(fill) ?? NAMED_COLORS[DEFAULT_COLOR];
  return contrast(hex, SURFACES[theme]) >= READABLE ? hex : standOff(hex, theme, 3);
}

// HSV for the picker: hue 0-360, saturation and value 0-1.
export function hexToHsv(hex: string) {
  const [r, g, b] = parseHex(hex).map(c => c / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: max === 0 ? 0 : d / max, v: max };
}
export function hsvToHex({ h, s, v }: { h: number; s: number; v: number }) {
  const f = (n: number) => { const k = (n + h / 60) % 6; return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255; };
  return toHex([f(5), f(3), f(1)]);
}
