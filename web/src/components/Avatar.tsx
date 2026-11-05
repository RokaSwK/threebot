import { useLayoutEffect, useRef } from "react";
import clsx from "clsx";
import { AvatarPlayer } from "./avatarPlayer";
import { ObjectAvatar } from "./ObjectAvatar";
import { isObjectShape, objectDefinition, safeDefinition } from "../lib/objectAvatars";
import { useApp } from "../store";
import { botColor, type AvatarState } from "../lib/character";

export { SHAPE_NAMES, COLORS, COLOR_NAMES, botColor } from "../lib/character";
export type { AppAvatarState, AvatarState } from "../lib/character";

export function Avatar({
  shape = "sphere",
  color = "teal",
  size = 32,
  state = "idle",
  star = false,
  className,
  picture,
  definition,
  still = false,
}: {
  shape?: string;
  color?: string;
  size?: number;
  state?: AvatarState;
  star?: boolean;
  className?: string;
  picture?: string | null;
  /** A look that isn't saved on a Bot yet, such as an import being previewed. */
  definition?: unknown;
  still?: boolean;
}) {
  const object = useApp((s) => !picture && isObjectShape(shape) ? safeDefinition(definition) ?? objectDefinition(shape, Object.values(s.bots)) ?? objectDefinition(shape, Object.values(s.historicalBots)) : null);
  const svg = useRef<SVGSVGElement>(null);
  const player = useRef<AvatarPlayer | null>(null);
  // An object nobody can resolve, such as one a Bot wrote badly, falls back to the ball.
  const engineShape = isObjectShape(shape) ? "ball" : shape;
  const props = { shape: engineShape, fill: botColor(color), size, state };
  const latest = useRef(props);
  latest.current = props;

  useLayoutEffect(() => {
    if (!svg.current || object) return;
    const p = new AvatarPlayer(svg.current, latest.current);
    player.current = p;
    return () => {
      p.destroy();
      player.current = null;
    };
  }, [picture, !object]);

  useLayoutEffect(() => {
    player.current?.update({ shape: engineShape, fill: botColor(color), size, state });
  }, [engineShape, color, size, state, picture]);

  return (
    <span className={clsx("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
      {picture ? <img src={picture} width={size} height={size} alt="" className="size-full rounded-full object-cover" /> : object ? <ObjectAvatar key={object.id} definition={object} color={color} size={size} state={state} still={still} /> : <svg ref={svg} width={size} height={size} className="overflow-visible" aria-hidden="true" />}
      {star && (
        <span
          className="absolute -right-0.5 -bottom-0.5 grid place-items-center rounded-full bg-pill text-pill-fg ring-2 ring-[var(--bg-sidebar)]"
          style={{ width: Math.max(12, size * 0.32), height: Math.max(12, size * 0.32), fontSize: Math.max(7, size * 0.2) }}
        >
          ★
        </span>
      )}
    </span>
  );
}

export function GroupAvatar({ members, size = 32 }: { members: { shape: string; color: string; avatarImage?: string | null }[]; size?: number }) {
  const s = size * 0.56;
  const spots = [
    { left: size * 0.22, top: 0 },
    { left: 0, top: size * 0.44 },
    { left: size * 0.44, top: size * 0.44 },
  ];
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      {members.slice(0, 3).map((m, i) => (
        <span key={i} className="absolute" style={spots[i]}>
          <Avatar shape={m.shape} color={m.color} picture={m.avatarImage} size={s} />
        </span>
      ))}
    </span>
  );
}
