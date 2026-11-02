export function decorateT3Avatar(svg: SVGSVGElement, parts: { body: SVGPathElement; eyes: SVGPathElement[] }): {
  step(seconds: number): void;
  holdFrame(): void;
  setState(state: string): void;
  setGazeTarget(point: { x: number; y: number } | null): void;
  eyeTarget(): { x: number; y: number } | null;
  setFold(amount: number): void;
  setSize(size: number): void;
};
