// Keep the responsive media conditions in index/mobile-chat/mobile-settings.css in sync.
export const MOBILE_LAYOUT_QUERY = "(max-width: 760px), (pointer: coarse) and (max-width: 1024px)";

export const COLUMN_LIMITS = {
  sidebar: { min: 240, max: 400, initial: 280 },
  details: { min: 280, max: 480, initial: 320 },
};
export type Column = keyof typeof COLUMN_LIMITS;
export function columnWidth(column: Column, value: unknown) {
  const limits = COLUMN_LIMITS[column];
  const width = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : limits.initial;
  return Number.isFinite(width) ? Math.round(Math.max(limits.min, Math.min(limits.max, width))) : limits.initial;
}
