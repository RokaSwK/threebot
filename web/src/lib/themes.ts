import type { Settings } from "./types";

export type Palette = Settings["palette"];

/** Colour themes. The first five come from T3 Code's palettes (MIT), the rest are ours. */
export const PALETTES: { id: Palette; label: string; dark: [bg: string, accent: string]; light?: [bg: string, accent: string] }[] = [
  { id: "amoled", label: "AMOLED", dark: ["#000000", "#f5f5f7"] },
  { id: "midnight", label: "Midnight", dark: ["#121020", "#8c8ef2"], light: ["#f9f8fd", "#5b55e0"] },
  { id: "t3", label: "T3", dark: ["#0a0a0a", "#60a5fa"], light: ["#fcfcfc", "#3b82f6"] },
  { id: "t3-chat", label: "T3 Chat", dark: ["oklch(0.228 0.02 307)", "oklch(0.75 0.16 4)"], light: ["oklch(0.982 0.01 326)", "oklch(0.59 0.22 1)"] },
  { id: "grove", label: "Grove", dark: ["oklch(0.26 0.02 163)", "oklch(0.8 0.13 157)"], light: ["oklch(0.972 0.005 157)", "oklch(0.52 0.11 158)"] },
  { id: "ocean", label: "Ocean", dark: ["oklch(0.243 0.024 251)", "oklch(0.76 0.11 242)"], light: ["oklch(0.974 0.003 242)", "oklch(0.54 0.12 247)"] },
  { id: "ember", label: "Ember", dark: ["oklch(0.246 0.019 42)", "oklch(0.76 0.12 52)"], light: ["oklch(0.977 0.003 61)", "oklch(0.55 0.13 45)"] },
  { id: "iris", label: "Iris", dark: ["oklch(0.226 0.031 294)", "oklch(0.67 0.17 294)"], light: ["oklch(0.977 0.004 303)", "oklch(0.53 0.15 294)"] },
];

export const DEFAULT_PALETTE: Palette = "amoled";

export function paletteLabel(id: string | undefined) {
  return PALETTES.find((palette) => palette.id === id)?.label ?? PALETTES[0].label;
}

/** Whether the document should use dark tokens for this mode and OS preference. */
export function isDarkMode(theme: Settings["theme"], systemDark: boolean) {
  return theme === "dark" || (theme === "system" && systemDark);
}
