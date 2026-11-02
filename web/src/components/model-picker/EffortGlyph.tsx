// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5): apps/web/src/components/chat/EffortGlyph.tsx
// and the trigger styles of chat/ComposerControl.tsx.
import clsx from "clsx";
import type { SelectDescriptor } from "../../lib/modelTraits";

export type ComposerControlSize = "sm" | "xs";

/** T3's ComposerControl look, on this app's tokens. */
export function composerControlClassName(size: ComposerControlSize, className?: string) {
  return clsx(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-transparent outline-none select-none",
    "hover:bg-hover aria-expanded:bg-hover focus-visible:ring-2 focus-visible:ring-line-strong focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-60",
    "pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97]",
    size === "xs"
      ? "h-7 gap-1 px-[7px] text-sm font-normal text-fg/70 hover:text-fg sm:h-6 sm:text-xs"
      : "h-7 gap-1.5 px-2 text-base font-medium text-fg/80 hover:text-fg aria-expanded:text-fg sm:text-sm",
    className,
  );
}

const GLYPH_HEIGHT_SM = 14;
const GLYPH_HEIGHT_XS = 12;
// Bars stop this far above the box's bottom, which puts their flat base on the text baseline.
const BASELINE_INSET = 2;

// Ultracode changes the workflow, not only intensity, so it keeps its name like Ultrathink.
// Max is named too, so the full scale stops short of it.
const NAMED_LEVELS = new Set(["ultracode", "max"]);
const OFF_LEVELS = new Set(["off", "none"]);

/**
 * Maps a reasoning select to bars: one per ordinary level, filled up to the current one, with an
 * off level as none filled. Max, prompt-injected and workflow levels are named instead of drawn.
 */
export function resolveEffortGlyph(descriptor: SelectDescriptor, current: string | null) {
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS]);
  const levels = descriptor.options.filter((option) => !special.has(option.id));
  if (levels.length < 2 || current === null) return null;
  const startsAtOff = OFF_LEVELS.has(levels[0].id);
  const count = startsAtOff ? levels.length - 1 : levels.length;
  if (special.has(current)) {
    const label = descriptor.options.find((option) => option.id === current)?.label ?? current;
    return { count, filled: count, special: label, label };
  }
  const index = levels.findIndex((option) => option.id === current);
  if (index < 0) return null;
  return { count, filled: startsAtOff ? index : index + 1, special: null, label: levels[index].label };
}

/** Bar heights that rise by one whole-pixel step, from about half height up to `maxBar`. */
export function effortBarHeights(count: number, maxBar: number): number[] {
  const step = Math.max(1, Math.round(maxBar / 2 / Math.max(count - 1, 1)));
  return Array.from({ length: count }, (_, index) => maxBar - (count - 1 - index) * step);
}

/** Rising bars on whole pixels so they stay sharp on 1x displays. Color follows the text. */
export function EffortGlyph(props: { count: number; filled: number; size?: ComposerControlSize }) {
  const height = props.size === "xs" ? GLYPH_HEIGHT_XS : GLYPH_HEIGHT_SM;
  const step = 4;
  const width = step * props.count - 2;
  const maxBar = height - BASELINE_INSET;
  return (
    <svg aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width, height }} className="shrink-0 text-current">
      {effortBarHeights(props.count, maxBar).map((barHeight, index) => {
        const x = index * step;
        return <rect key={x} x={x} y={maxBar - barHeight} width={2} height={barHeight} fill="currentColor" opacity={index < props.filled ? 1 : 0.4} />;
      })}
    </svg>
  );
}
