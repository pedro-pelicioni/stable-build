import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { leakMessage, leakedViteKeys } from "./src/config/env-guard.ts";

// PAGES_BASE is set by .github/workflows/pages.yml (e.g. "/my-repo/").
export default defineConfig(({ mode }) => {
  // Every VITE_* value (shell or .env files) is copied into the public bundle. A value shaped like a
  // private key stops `vite dev` and `vite build` here, before anything is written to dist/.
  const leaked = leakedViteKeys(loadEnv(mode, process.cwd(), "VITE_"));
  if (leaked.length > 0) throw new Error(leakMessage(leaked));
  return {
    base: process.env.PAGES_BASE || "/",
    plugins: [react()],
    // viem + react make a ~550 kB bundle (~170 kB gzip); raise the warning threshold.
    build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 800 },
    test: {
      include: ["test/**/*.test.ts"],
      environment: "node",
    },
  };
});
