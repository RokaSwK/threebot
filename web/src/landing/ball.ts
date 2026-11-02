// The real ball on the public landing page: click for its next state, hover to push the clouds.
import { createCharacter } from "../lib/character";

// Only states where the whole ball stays on screen. The folded ones shrink it to a dot.
const STATES = ["sleeping", "angry", "happy", "surprised", "laughing", "humming", "scared", "curious", "proud", "suspicious", "excited", "sad"];
type Ball = { element: HTMLElement; character: ReturnType<typeof createCharacter>; visible: boolean };

function mount(element: HTMLElement): Ball {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  element.append(svg);
  const character = createCharacter(svg, { shape: "t3", state: "idle", fill: "#A97EFE", size: element.clientWidth });
  element.classList.add("is-live");
  let next = 0;
  element.addEventListener("click", () => {
    const state = STATES[next++ % STATES.length];
    character.setState(state);
    element.animate([{ transform: "scale(1)" }, { transform: "scale(1.12, .9)" }, { transform: "scale(.96, 1.05)" }, { transform: "scale(1)" }], { duration: 420, easing: "ease-out" });
    const hint = element.parentElement?.querySelector<HTMLElement>("[data-ball-state]");
    if (hint) hint.textContent = state;
  });
  new ResizeObserver(() => character.setSize(element.clientWidth)).observe(element);
  return { element, character, visible: true };
}

if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const balls = [...document.querySelectorAll<HTMLElement>("[data-live-ball]")].map(mount);
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const ball = balls.find(({ element }) => element === entry.target);
      if (ball) ball.visible = entry.isIntersecting;
    }
  });
  balls.forEach(({ element }) => seen.observe(element));
  addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    for (const { character } of balls) character.setGazeTarget({ x: event.clientX, y: event.clientY });
  }, { passive: true });
  let last = performance.now();
  const frame = (now: number) => {
    const seconds = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const ball of balls) if (ball.visible) ball.character.step(seconds);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
