type BackGuard = () => boolean;

let active: BackGuard | null = null;

/**
 * A screen that sits on top of a route (an editor, a confirmation) can claim the browser's Back
 * button without owning a history entry. The guard returns true when it handled the Back, and the
 * navigation hook keeps the current route pinned until the screen releases it.
 */
export function registerBackGuard(guard: BackGuard): () => void {
  active = guard;
  return () => {
    if (active === guard) active = null;
  };
}

export function runBackGuard(): boolean {
  return active?.() ?? false;
}
