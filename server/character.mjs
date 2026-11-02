// The Pingbot character: one SVG body, two eyes and a layer of effects, all drawn from
// numbers each frame. Works in a browser and under linkedom on the server, where it only
// ever renders a still frame. Nothing here reads the clock: callers advance it with step().
const NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
export const RADIUS = 114.27;
const CENTER = RADIUS;
export const VIEW_HALF = RADIUS * 1.1;
const POINTS = 96;
const EYE_POINTS = 28;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const mix = (a, b, t) => a + (b - a) * t;
const approach = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
const wave = (t, speed, phase = 0) => Math.sin(t * speed * TAU + phase);
const fixed = (n) => (Math.abs(n) < 1e-4 ? 0 : n).toFixed(2);

// Silhouettes are radius functions of angle, so any two can morph without matching points.
const superellipse = (n, ax = 1, ay = 1) => (a) => {
  const c = Math.abs(Math.cos(a)) / ax, s = Math.abs(Math.sin(a)) / ay;
  return 1 / Math.pow(c ** n + s ** n, 1 / n);
};
const polygon = (sides, rotation, softness) => (a) => {
  const step = TAU / sides, local = ((a - rotation) % step + step) % step - step / 2;
  return mix(Math.cos(Math.PI / sides) / Math.cos(local), 1, softness);
};
const lobes = (count, depth, phase = 0, sharpness = 1) => (a) => 1 - depth + depth * ((1 + Math.cos(count * a + phase)) / 2) ** sharpness;
// Measured from the top of the shape: a notch, two lobes, then in to a soft point.
const heart = (a) => {
  const x = Math.abs(Math.atan2(Math.cos(a), -Math.sin(a))) / Math.PI;
  if (x < 0.3) return 0.74 + 0.27 * Math.sin((x / 0.3) * (Math.PI / 2));
  return 1.01 - 0.28 * Math.sin(((x - 0.3) / 0.7) * Math.PI) ** 0.8 + 0.1 * Math.max(0, (x - 0.86) / 0.14);
};
const SILHOUETTES = {
  ball: () => 1,
  blob: (a) => 0.94 + 0.05 * Math.sin(2 * a + 0.6) + 0.03 * Math.sin(3 * a + 1.4),
  pebble: superellipse(2.4, 1, 0.82),
  squircle: superellipse(4.4, 0.9, 0.9),
  tablet: superellipse(4.2, 0.72, 1),
  capsule: superellipse(2.9, 0.62, 1),
  hex: polygon(6, 0, 0.14),
  gem: polygon(4, 0, 0.12),
  wedge: polygon(3, -Math.PI / 2, 0.16),
  drop: (a) => 0.7 + 0.3 * ((1 + Math.sin(a)) / 2) ** 0.7 + 0.22 * ((1 - Math.sin(a)) / 2) ** 6,
  cloud: lobes(6, 0.15, Math.PI / 6, 0.7),
  flower: lobes(6, 0.26, Math.PI / 2, 1),
  clover: lobes(4, 0.3, 0, 0.8),
  star: lobes(5, 0.4, Math.PI / 2, 1.3),
  spark: lobes(4, 0.46, 0, 1.3),
  heart,
  dome: (a) => (Math.sin(a) < 0 ? 0.98 : superellipse(5, 0.98, 0.84)(a)),
};
export const SILHOUETTE_NAMES = Object.keys(SILHOUETTES);
const silhouette = (name) => SILHOUETTES[name] ?? SILHOUETTES.ball;

// A face is two soft bars. gap and y place them, length and width size them, tilt leans
// them (mirrored by lean), bend curves them, round takes them from bar to circle.
const FACE = { gap: 30, y: -8, length: 60, width: 22, tilt: 0, lean: 0, bend: 0, round: 3.4, left: 1, right: 1, sweep: 0 };
const LIFE = { squash: 0, bob: 0, bobSpeed: 0.5, rock: 0, rockSpeed: 0.4, spin: 0, breathe: 1, blink: true };
const face = (values) => ({ ...FACE, ...values });
const POSES = {
  idle: face({}),
  waking: face({ length: 50, width: 18 }),
  sleeping: face({ y: 18, length: 7, width: 46, gap: 34, bend: 3, blink: false, breathe: 2 }),
  drowsy: face({ y: 14, length: 5, width: 50, gap: 36, tilt: 5, blink: false, breathe: 1.5 }),
  listening: face({ length: 64, width: 23, lean: 16, y: 6, bob: 3 }),
  searching: face({ length: 44, width: 44, round: 2, gap: 34, sweep: 26, bob: 1 }),
  working: face({ length: 54, width: 20, y: -2, lean: -18, gap: 32, rock: 2 }),
  excited: face({ length: 56, width: 52, round: 2, gap: 36, y: 16, bob: 8, bobSpeed: 2 }),
  surprised: face({ length: 58, width: 52, round: 2, gap: 38, y: 10, squash: -0.05 }),
  curious: face({ length: 50, width: 46, round: 2, gap: 30, y: 2, left: 1.1, right: 0.84, rock: 3 }),
  suspicious: face({ length: 10, width: 44, gap: 34, y: 4, tilt: 7 }),
  angry: face({ length: 62, width: 22, lean: 28, gap: 34, y: 8, rock: 1.5, rockSpeed: 7 }),
  happy: face({ length: 66, width: 34, lean: -16, gap: 36, y: 22, bob: 4, bobSpeed: 1.2 }),
  shy: face({ length: 14, width: 34, gap: 30, y: 16, bend: -6, rock: 1 }),
  confused: face({ length: 52, width: 18, left: 1.1, right: 0.72, tilt: 16, y: 0, rock: 4 }),
  bored: face({ length: 6, width: 42, gap: 32, y: 12, blink: false }),
  proud: face({ length: 40, width: 16, gap: 44, y: 8, squash: -0.03 }),
  sad: face({ length: 7, width: 46, gap: 34, y: 16, lean: -14, blink: false }),
  laughing: face({ length: 46, width: 36, gap: 36, y: 22, round: 3, bend: 7, bob: 7, bobSpeed: 3 }),
  scared: face({ length: 64, width: 54, round: 2, gap: 40, y: 8, rock: 1.2, rockSpeed: 11 }),
  playful: face({ length: 50, width: 36, lean: -20, gap: 36, y: 20, rock: 6, rockSpeed: 1.2 }),
  celebrate: face({ length: 44, width: 48, round: 2, gap: 40, y: 0, spin: 0.7 }),
  humming: face({ length: 8, width: 40, gap: 32, y: 6, bend: 5, bob: 3, bobSpeed: 1 }),
  notifying: face({ length: 54, width: 50, round: 2, gap: 38, y: 18, bob: 5, bobSpeed: 1.4 }),
  dragging: face({ length: 44, width: 26, y: 8, rock: 8, rockSpeed: 1.6 }),
};
// Folded states pull the body down to a small planet and hand the frame to an effect.
const FOLDS = { thinking: 1, orbit: 1, radar: 1, progress: 1, spawning: 1, loading: 1, dictating: 1, writing: 1, sending: 1, receiving: 1, uploading: 1, alerting: 1, bouncing: 1, "powering-down": 1 };
const FOLD_SCALE = 0.17;
const pose = (state) => ({ ...LIFE, ...(POSES[state] ?? POSES.idle) });

function eyePath(cx, cy, length, width, tilt, bend, round) {
  const half = Math.max(length, 0.1) / 2, thick = Math.max(width, 0.1) / 2, turn = (tilt * Math.PI) / 180;
  const cos = Math.cos(turn), sin = Math.sin(turn), points = [];
  const horizontal = thick > half;
  const major = Math.max(half, thick), minor = Math.min(half, thick);
  for (let i = 0; i < EYE_POINTS; i++) {
    const a = (i / EYE_POINTS) * TAU, ca = Math.cos(a), sa = Math.sin(a);
    const r = 1 / Math.pow(Math.abs(ca) ** round + Math.abs(sa) ** round, 1 / round);
    let along = ca * r * major, across = sa * r * minor;
    across += bend * (1 - (along / major) ** 2);
    const x = horizontal ? along : across, y = horizontal ? across : along;
    points.push(`${i ? "L" : "M"}${fixed(cx + x * cos - y * sin)} ${fixed(cy + x * sin + y * cos)}`);
  }
  return points.join("") + "Z";
}

// Most attributes hold still between frames. Only touching the ones that moved keeps
// the browser's style and layout work small when many avatars are on screen.
const written = new WeakMap();
function set(el, name, value) {
  let cache = written.get(el);
  if (!cache) written.set(el, cache = new Map());
  const text = String(value);
  if (cache.get(name) === text) return;
  cache.set(name, text);
  el.setAttribute(name, text);
}

let serial = 0;

export class Character {
  constructor(svg, { shape = "ball", state = "idle", inkFlat = "#A97EFE", eyeColor = "#000", sizePx = 64, reduceMotion = false, paused, badgeColor, random = Math.random } = {}) {
    svg.replaceChildren?.();
    this.svg = svg;
    this.random = random;
    this.document = svg.ownerDocument;
    this.state = state;
    this.ink = inkFlat;
    this.time = 0;
    this.stateTime = 0;
    this.blinkIn = 1 + random() * 3;
    this.blink = 0;
    this.gazeTarget = null;
    this.gaze = { x: 0, y: 0 };
    this.overlay = { x: FOLDS[state] ? 1 : 0 };
    this.from = shape;
    this.to = shape;
    this.morph = 1;
    this.frozen = false;
    this.current = pose(state);
    this.rect = null;
    this.rectAge = 1;
    const id = `pingbot-${++serial}`;
    svg.setAttribute("viewBox", `${fixed(CENTER - VIEW_HALF)} ${fixed(CENTER - VIEW_HALF)} ${fixed(VIEW_HALF * 2)} ${fixed(VIEW_HALF * 2)}`);
    this.setSize(sizePx);
    svg.style?.setProperty("--fg", inkFlat);
    const defs = this.node("defs", {}, svg);
    const clip = this.node("clipPath", { id }, defs);
    this.clipBody = this.node("path", {}, clip);
    this.back = this.node("g", { "aria-hidden": "true" }, svg);
    this.figure = this.node("g", { "data-figure": "" }, svg);
    this.body = this.node("path", { fill: inkFlat }, this.figure);
    const eyes = this.node("g", {}, this.figure);
    this.eyes = [this.node("path", { fill: eyeColor }, eyes), this.node("path", { fill: eyeColor }, eyes)];
    this.front = this.node("g", { "aria-hidden": "true" }, svg);
    if (badgeColor) this.front.setAttribute("data-badge", badgeColor);
    const ink = `var(--fg, ${inkFlat})`;
    this.dots = Array.from({ length: 7 }, () => this.node("circle", { fill: ink, r: 0, opacity: 0 }, this.front));
    this.rings = Array.from({ length: 4 }, () => this.node("circle", { fill: "none", stroke: ink, "stroke-linecap": "round", pathLength: 1, r: 0, opacity: 0 }, this.back));
    this.ribbons = Array.from({ length: 6 }, () => this.node("path", { fill: "none", stroke: ink, "stroke-linecap": "round", opacity: 0 }, this.front));
    this.paint(0);
    if (reduceMotion || paused) this.holdFrame();
  }

  node(tag, attrs, parent) {
    const el = this.document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    parent.appendChild(el);
    return el;
  }

  parts() { return { body: this.body, eyes: this.eyes }; }
  setInk(color) { this.ink = color; set(this.body, "fill", color); this.svg.style?.setProperty("--fg", color); }
  setSize(size) { this.svg.setAttribute("width", String(size)); this.svg.setAttribute("height", String(size)); this.rectAge = 1; }
  setGazeTarget(point) { this.gazeTarget = point; }
  setShape(shape) { if (shape === this.to) return; this.from = this.to; this.to = shape; this.morph = 0; }
  setState(state) { if (state !== this.state) { this.state = state; this.stateTime = 0; this.spinAngle = 0; } }
  holdFrame() { this.frozen = true; this.morph = 1; this.current = pose(this.state); this.overlay.x = FOLDS[this.state] ? 1 : 0; this.blink = 0; this.gaze = { x: 0, y: 0 }; this.paint(0); }
  destroy() {}

  step(seconds) {
    if (this.frozen) return;
    const dt = clamp(seconds, 0, 0.1);
    this.time += dt;
    this.stateTime += dt;
    this.morph = Math.min(1, this.morph + dt * 3.2);
    const target = pose(this.state);
    for (const key of Object.keys(target)) if (typeof target[key] === "number") this.current[key] = approach(this.current[key], target[key], 13, dt);
    this.overlay.x = approach(this.overlay.x, FOLDS[this.state] ? 1 : 0, 10, dt);
    this.blinkIn -= dt;
    if (this.blinkIn <= 0 && target.blink) { this.blink = 0.14; this.blinkIn = 2.2 + this.random() * 3.6; }
    this.blink = Math.max(0, this.blink - dt);
    this.rectAge += dt;
    if (this.gazeTarget && this.rectAge > 0.25) { this.rect = this.svg.getBoundingClientRect?.() ?? null; this.rectAge = 0; }
    const rect = this.rect, point = this.gazeTarget;
    const gx = point && rect?.width ? clamp((point.x - rect.left) / rect.width - 0.5, -0.6, 0.6) : 0;
    const gy = point && rect?.height ? clamp((point.y - rect.top) / rect.height - 0.5, -0.6, 0.6) : 0;
    this.gaze.x = approach(this.gaze.x, gx * 34, 9, dt);
    this.gaze.y = approach(this.gaze.y, gy * 24, 9, dt);
    this.paint(dt);
  }

  bodyPath(scale, sx, sy, dy) {
    const a = silhouette(this.from), b = silhouette(this.to), m = this.morph * this.morph * (3 - 2 * this.morph), points = [];
    for (let i = 0; i < POINTS; i++) {
      const angle = (i / POINTS) * TAU, r = RADIUS * scale * mix(a(angle), b(angle), m);
      points.push([CENTER + Math.cos(angle) * r * sx, CENTER + dy + Math.sin(angle) * r * sy]);
    }
    let path = "";
    for (let i = 0; i < POINTS; i++) {
      const [x, y] = points[i], [nx, ny] = points[(i + 1) % POINTS];
      path += i ? `Q${fixed(x)} ${fixed(y)} ${fixed((x + nx) / 2)} ${fixed((y + ny) / 2)}` : `M${fixed((x + nx) / 2)} ${fixed((y + ny) / 2)}`;
    }
    return path + "Z";
  }

  paint(dt = 0) {
    const p = this.current, t = this.time, fold = this.overlay.x, open = 1 - fold;
    const breath = this.frozen ? 0 : wave(t, 0.28) * 0.011 * p.breathe;
    const squash = p.squash + breath, bob = this.frozen ? 0 : wave(t, p.bobSpeed) * p.bob;
    const drop = this.state === "alerting" ? fold * 62 : this.state === "writing" ? fold * 44 : this.state === "bouncing" ? fold * (20 - Math.abs(wave(t, 1.1)) * 70) : 0;
    const shrink = this.state === "powering-down" ? clamp(1 - this.stateTime / 1.2, 0, 1) : 1;
    const scale = mix(1, FOLD_SCALE, fold) * mix(1, 0.12, 1 - shrink);
    const path = this.bodyPath(scale, 1 - squash, 1 + squash, bob * open + drop);
    set(this.body, "d", path);
    set(this.clipBody, "d", path);
    const rock = this.frozen ? 0 : wave(t, p.rockSpeed) * p.rock;
    this.spinAngle = (this.spinAngle ?? 0) + (this.frozen ? 0 : p.spin * 360 * dt);
    set(this.figure, "transform", `rotate(${fixed((rock + this.spinAngle) * open)} ${fixed(CENTER)} ${fixed(CENTER)})`);
    const blink = this.blink > 0 ? Math.abs(this.blink / 0.07 - 1) * 0.92 + 0.08 : 1;
    const sweep = p.sweep ? wave(t, 0.8) * p.sweep : 0;
    const x = this.gaze.x + sweep, y = this.gaze.y + bob;
    const place = (index, side) => {
      const size = side < 0 ? p.left : p.right;
      const d = eyePath(CENTER + side * p.gap + x, CENTER + p.y + y, p.length * size * blink * open, p.width * size * open, p.tilt * 1 + side * p.lean, p.bend, Math.max(p.round, 2));
      set(this.eyes[index], "d", d);
    };
    place(0, -1);
    place(1, 1);
    this.effects(t, fold);
  }

  effects(t, fold) {
    const state = this.state, dots = this.dots, rings = this.rings, ribbons = this.ribbons;
    const touched = new Set(), rib = (i) => (touched.add(ribbons[i]), ribbons[i]);
    const dot = (i, x, y, r, opacity = 1) => { const el = dots[i]; touched.add(el); set(el, "cx", fixed(CENTER + x)); set(el, "cy", fixed(CENTER + y)); set(el, "r", fixed(Math.max(r, 0))); set(el, "opacity", fixed(opacity * fold)); };
    const ring = (i, r, width, opacity, dash, offset = 0) => { const el = rings[i]; touched.add(el); set(el, "cx", fixed(CENTER)); set(el, "cy", fixed(CENTER)); set(el, "r", fixed(r)); set(el, "stroke-width", fixed(width)); set(el, "opacity", fixed(opacity)); set(el, "stroke-dasharray", dash ?? "1 0"); set(el, "stroke-dashoffset", fixed(offset)); };
    const pulse = (speed, phase) => (t * speed + phase) % 1;
    switch (state) {
      case "thinking":
        [-1, 1].forEach((side, i) => dot(i, side * 62, 0, 11 + 5 * Math.max(0, wave(t, 1.3, i * Math.PI)), 0.55 + 0.45 * Math.max(0, wave(t, 1.3, i * Math.PI))));
        break;
      case "orbit":
        for (let i = 0; i < 4; i++) { const a = t * TAU * 0.5 + (i * TAU) / 4; dot(i, Math.cos(a) * 78, Math.sin(a) * 30, 7 + 5 * ((1 + Math.sin(a)) / 2)); }
        break;
      case "radar":
        for (let i = 0; i < 3; i++) { const f = pulse(0.55, i / 3); ring(i, 26 + f * 92, 3.2, (1 - f) * 0.85 * fold); }
        break;
      case "progress": {
        const f = pulse(0.32, 0);
        ring(0, 72, 3, 0.2 * fold);
        ring(1, 72, 7, fold, `${fixed(f)} ${fixed(1 - f)}`, 0.25);
        break;
      }
      case "spawning":
        for (let i = 0; i < 6; i++) { const f = pulse(0.7, i / 12), a = (i / 6) * TAU + 0.4; dot(i, Math.cos(a) * (24 + f * 86), Math.sin(a) * (24 + f * 86), (1 - f) * 11, 1 - f * 0.5); }
        break;
      case "loading":
        for (let i = 0; i < 3; i++) ring(i, 72, 9 - i * 2.4, (0.95 - i * 0.3) * fold, `${0.16 + i * 0.09} 1`, -(t * 0.9) + i * 0.02);
        break;
      case "dictating":
        for (let i = 0; i < 4; i++) dot(i, -36 + i * 24 + (i > 1 ? 12 : -12), wave(t, 1.6, i * 0.9) * 16, 8);
        break;
      case "writing": {
        const r = rib(0), a = 0.34 + wave(t, 1.3) * 0.12, tipX = CENTER + 18, tipY = CENTER + 26 + wave(t, 2.6) * 6;
        set(r, "d", `M${fixed(tipX)} ${fixed(tipY)}L${fixed(tipX + Math.sin(a) * 84)} ${fixed(tipY - Math.cos(a) * 84)}`);
        set(r, "stroke-width", "20"); set(r, "opacity", fixed(fold));
        break;
      }
      case "sending":
        for (let i = 0; i < 2; i++) { const f = pulse(0.8, i / 2); ring(i, 24 + f * 76, 3.2, (1 - f) * fold); }
        break;
      case "receiving":
        for (let i = 0; i < 3; i++) { const f = pulse(0.9, i / 3); dot(i, (1 - f) * 100, 0, 8 * (0.4 + f * 0.6), f); }
        break;
      case "uploading":
        for (let i = 0; i < 3; i++) { const f = pulse(0.8, i / 3); dot(i, -24 + i * 24, 34 - f * 92, 9 * (1 - f * 0.5), 1 - f); }
        break;
      case "alerting": {
        const r = rib(0), kick = Math.abs(wave(t, 1.6)) * 6;
        // The tiny lean keeps the stroke's box wide enough for a gradient to paint.
        set(r, "d", `M${fixed(CENTER - 1)} ${fixed(CENTER - 88 - kick)}L${fixed(CENTER + 1)} ${fixed(CENTER + 18 - kick)}`);
        set(r, "stroke-width", "28"); set(r, "opacity", fixed(fold));
        break;
      }
      case "searching": {
        const open = 1 - fold;
        ring(0, RADIUS * 1.09, 7, 0.9 * open, "0.12 0.38", -t * 0.55);
        break;
      }
      case "celebrate":
        for (let i = 0; i < 6; i++) {
          const r = rib(i), a = t * (1.5 + i * 0.22) + (i * TAU) / 6, rx = RADIUS * (1.16 + (i % 3) * 0.13), ry = rx * (0.28 + (i % 3) * 0.2), start = a, end = a + 2.4;
          const at = (v) => [CENTER + Math.cos(v) * rx, CENTER + Math.sin(v) * ry];
          const turn = i * 31 + t * 26, [sx, sy] = at(start), [ex, ey] = at(end);
          set(r, "d", `M${fixed(sx)} ${fixed(sy)}A${fixed(rx)} ${fixed(ry)} 0 0 1 ${fixed(ex)} ${fixed(ey)}`);
          set(r, "transform", `rotate(${fixed(turn)} ${fixed(CENTER)} ${fixed(CENTER)})`);
          set(r, "stroke-width", fixed(6 + (i % 3) * 2)); set(r, "opacity", "0.92");
        }
        break;
      case "humming":
        for (let i = 0; i < 4; i++) {
          const r = rib(i), y = CENTER - 60 + i * 42, phase = t * 2.6 + i * 1.3, span = RADIUS * 1.25;
          let d = "";
          for (let k = 0; k <= 12; k++) { const u = k / 12, x = CENTER - span + u * span * 2, h = Math.sin(u * 7 + phase) * 22 * Math.sin(u * Math.PI); d += `${k ? "L" : "M"}${fixed(x)} ${fixed(y + h)}`; }
          set(r, "d", d); set(r, "transform", ""); set(r, "stroke-width", "5"); set(r, "opacity", fixed(0.5 + 0.4 * Math.sin(t * 2 + i)));
        }
        break;
      default:
    }
    for (const el of [...dots, ...rings, ...ribbons]) if (!touched.has(el)) set(el, "opacity", "0");
  }
}

export function createEngine(svg, options) {
  return new Character(svg, options);
}
