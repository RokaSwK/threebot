export const RADIUS: number;
export const VIEW_HALF: number;
export const SILHOUETTE_NAMES: string[];
export class Character {
  constructor(svg: SVGSVGElement, options?: { shape?: string; state?: string; inkFlat?: string; eyeColor?: string; sizePx?: number; reduceMotion?: boolean; paused?: string; badgeColor?: string; random?: () => number });
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
