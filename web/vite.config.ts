import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pwaPrecache } from "./plugins/pwaPrecache.ts";

const gateway = process.env.BOT_GATEWAY ?? "http://127.0.0.1:3780";
// Optional for local development: a gateway session cookie, so the dev server can talk to it without a browser login.
const devCookie = process.env.BOT_SESSION ? { cookie: `bot_session=${process.env.BOT_SESSION}` } : undefined;

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaPrecache()],
  server: {
    port: 5180,
    proxy: {
      "/api": { target: gateway, changeOrigin: true, headers: devCookie },
      "/t3": { target: gateway, changeOrigin: true, ws: true, headers: devCookie },
    },
  },
});
