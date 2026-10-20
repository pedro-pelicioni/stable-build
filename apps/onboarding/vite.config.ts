import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { leakMessage, leakedViteKeys } from "./src/config/env-guard.ts";

function chatDevApi(): Plugin {
  return {
    name: "onboarding-chat-dev",
    configureServer(server) {
      server.middlewares.use("/api/chat", async (req, res) => {
        const { default: handler } = await import("./api/chat.ts");
        await handler(req as IncomingMessage, res as ServerResponse);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Every VITE_* value (shell or .env files) is copied into the public bundle. A value shaped like a
  // private key stops `vite dev` and `vite build` here, before anything is written to dist/.
  const leaked = leakedViteKeys(loadEnv(mode, process.cwd(), "VITE_"));
  if (leaked.length > 0) throw new Error(leakMessage(leaked));
  return {
    plugins: [react(), chatDevApi()],
    build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 800 },
    server: { port: 5173 },
    test: {
      include: ["test/**/*.test.ts"],
      environment: "node",
    },
  };
});
