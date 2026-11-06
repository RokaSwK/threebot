// The real characters on the public landing page.
// [data-live-ball] is the T3 ball: click it for its next state.
// [data-bot] is any Bot face: data-shape, data-color and data-state pick how it looks,
// and changing data-state later changes its mood. The page script calls
// window.threebotMount(root) after it adds new faces. With reduced motion the faces hold still.
import { COLORS, createCharacter, type AvatarState } from "../lib/character";

// Only states where the whole ball stays on screen. The folded ones shrink it to a dot.
const STATES = ["sleeping", "angry", "happy", "surprised", "laughing", "humming", "scared", "curious", "proud", "suspicious", "excited", "sad"];
type Face = { element: HTMLElement; character: ReturnType<typeof createCharacter>; visible: boolean };
const faces: Face[] = [];
// With reduced motion every face still appears, drawn once as a still frame.
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const mounted = new WeakSet<HTMLElement>();

const seen = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const face = faces.find(({ element }) => element === entry.target);
    if (face) face.visible = entry.isIntersecting;
  }
});

function mount(element: HTMLElement) {
  if (mounted.has(element)) return;
  mounted.add(element);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  element.append(svg);
  const ball = element.hasAttribute("data-live-ball");
  const shape = ball ? "t3" : element.dataset.shape ?? "ball";
  const color = element.dataset.color ?? "purple";
  const state = (element.dataset.state ?? "idle") as AvatarState;
  const character = createCharacter(svg, { shape, state, fill: COLORS[color] ?? color, size: element.clientWidth || 24 });
  if (still) character.holdFrame();
  element.classList.add("is-live");
  if (ball) {
    let next = 0;
    element.addEventListener("click", () => {
      const state = STATES[next++ % STATES.length];
      character.setState(state);
      if (still) character.holdFrame();
      else element.animate([{ transform: "scale(1)" }, { transform: "scale(1.12, .9)" }, { transform: "scale(.96, 1.05)" }, { transform: "scale(1)" }], { duration: 420, easing: "ease-out" });
      const hint = element.parentElement?.querySelector<HTMLElement>("[data-ball-state]");
      if (hint) hint.textContent = state;
    });
  }
  new MutationObserver(() => { character.setState(element.dataset.state ?? "idle"); if (still) character.holdFrame(); }).observe(element, { attributeFilter: ["data-state"] });
  new ResizeObserver(() => { if (element.clientWidth) { character.setSize(element.clientWidth); if (still) character.holdFrame(); } }).observe(element);
  faces.push({ element, character, visible: true });
  seen.observe(element);
}

function mountAll(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-live-ball], [data-bot]").forEach(mount);
}

(window as unknown as { threebotMount: typeof mountAll }).threebotMount = mountAll;
mountAll();

if (!still) {
  addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    for (const { character, visible } of faces) if (visible) character.setGazeTarget({ x: event.clientX, y: event.clientY });
  }, { passive: true });
  let last = performance.now();
  const frame = (now: number) => {
    const seconds = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (let i = faces.length - 1; i >= 0; i--) {
      const face = faces[i];
      // Faces the page script removed (the hero story restarts) are let go.
      if (!face.element.isConnected) { face.character.destroy(); seen.unobserve(face.element); faces.splice(i, 1); continue; }
      if (face.visible) face.character.step(seconds);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
