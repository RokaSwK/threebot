import type { IncomingMessage } from "node:http";

// Where the app answers. With a Tailscale listener configured, the full app can live on that port
// alone, and only `tailscale serve` should proxy to it: Serve sets the signed-in user's login on
// each request and replaces any value the client sent. The tailnet port never accepts Cloudflare
// tokens, and the normal port can be reduced to the public landing page.
export function exposureConfig(env = process.env) {
  return {
    tailnetPort: Number(env.TAILNET_PORT) || 0,
    tailnetUsers: new Set(String(env.TAILNET_USERS ?? "").split(",").map((user) => user.trim().toLowerCase()).filter(Boolean)),
    landingOnly: env.PUBLIC_LANDING_ONLY === "true",
  };
}

export type Exposure = ReturnType<typeof exposureConfig>;

export const onTailnet = (req: IncomingMessage, exposure: Exposure): boolean => exposure.tailnetPort > 0 && req.socket.localPort === exposure.tailnetPort;

export function tailnetUserAllowed(req: IncomingMessage, exposure: Exposure): boolean {
  return exposure.tailnetUsers.has(String(req.headers["tailscale-user-login"] ?? "").trim().toLowerCase());
}

/** The only paths the internet-facing port serves in landing-only mode. */
export function landingPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/welcome" || pathname === "/welcome/" || /^\/welcome\/(img|fonts)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathname);
}
