// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5): the popup behavior of
// apps/web/src/components/ui/popover.tsx and menu.tsx (Base UI there), plus lockBackgroundScroll
// from chat/ProviderModelPicker.tsx. A portaled layer anchored to its trigger: it flips to the side
// with room, stays inside the viewport, closes on outside press or Escape, and on touch screens a
// backdrop takes the outside tap so closing cannot also press the control beneath.
import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const VIEWPORT_PADDING = 8;

type Placement = { left: number; top?: number; bottom?: number; maxHeight: number };

export function isCoarsePointer() {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

export function Floating(props: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  side?: "top" | "bottom";
  align?: "start" | "end";
  sideOffset?: number;
  lockScroll?: boolean;
  /** Receives focus once the popup is placed (a hidden popup cannot take focus). */
  initialFocus?: () => HTMLElement | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  const { anchorRef, onClose, side = "bottom", align = "start", sideOffset = 4, lockScroll = false } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [coarse] = useState(isCoarsePointer);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRef = useRef(props.initialFocus);
  initialFocusRef.current = props.initialFocus;
  const placed = placement !== null;
  useEffect(() => {
    if (placed) initialFocusRef.current?.()?.focus({ preventScroll: true });
  }, [placed]);

  // Measures the trigger and the popup to place it; re-runs when either moves or resizes.
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const el = ref.current;
      if (!anchor || !el) return;
      const vw = document.documentElement.clientWidth;
      // Fixed positions resolve against the layout viewport.
      const vh = window.innerHeight;
      const width = el.offsetWidth;
      const height = el.scrollHeight;
      const below = vh - anchor.bottom - sideOffset - VIEWPORT_PADDING;
      const above = anchor.top - sideOffset - VIEWPORT_PADDING;
      const preferred = side === "bottom" ? below : above;
      const other = side === "bottom" ? above : below;
      const chosen = preferred >= height || preferred >= other ? side : side === "bottom" ? "top" : "bottom";
      const rawLeft = align === "start" ? anchor.left : anchor.right - width;
      const left = Math.max(VIEWPORT_PADDING, Math.min(rawLeft, vw - width - VIEWPORT_PADDING));
      setPlacement(
        chosen === "bottom"
          ? { left, top: anchor.bottom + sideOffset, maxHeight: below }
          : { left, bottom: vh - anchor.top + sideOffset, maxHeight: above },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, side, align, sideOffset]);

  // Closes on Escape before dialogs see it, and on presses outside the popup and its trigger.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCloseRef.current();
      anchorRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    if (!coarse) document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [anchorRef, coarse]);

  // Holds the page still behind the popup, like T3's model picker.
  useEffect(() => {
    if (!lockScroll) return;
    const prevent = (event: Event) => {
      if (event.target instanceof Element && ref.current?.contains(event.target)) return;
      event.preventDefault();
    };
    document.addEventListener("wheel", prevent, { capture: true, passive: false });
    document.addEventListener("touchmove", prevent, { capture: true, passive: false });
    return () => {
      document.removeEventListener("wheel", prevent, { capture: true });
      document.removeEventListener("touchmove", prevent, { capture: true });
    };
  }, [lockScroll]);

  return createPortal(
    <>
      {coarse && <div className="fixed inset-0 z-[70]" onClick={() => onCloseRef.current()} />}
      <div
        ref={ref}
        className={clsx(
          "pop-in fixed z-[71] flex overflow-hidden rounded-[10px] border border-line bg-elevated text-fg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%),var(--shadow-pop)] outline-none",
          props.className,
        )}
        style={
          placement
            ? ({
                left: placement.left,
                top: placement.top,
                bottom: placement.bottom,
                maxHeight: placement.maxHeight,
                // Like Base UI's --available-height: what children may grow to inside the 1px border.
                "--available-height": `${placement.maxHeight - 2}px`,
              } as CSSProperties)
            : { left: 0, top: 0, visibility: "hidden" }
        }
      >
        {props.children}
      </div>
    </>,
    document.body,
  );
}
