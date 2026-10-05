/**
 * Checks the payout CLI runs before it reads a key or touches the network. Kept apart from
 * payout.ts so they can be unit-tested (test/cli-gates.test.ts).
 */
import { loadEnv } from "vite";
import { leakMessage, leakedViteKeys } from "../src/config/env-guard";

export const CAP_PATTERN = /^\d+(\.\d{1,6})?$/;

/** VITE_* names that look like a private key: in the shell environment or in any .env file Vite
 * would load for `vite dev` (development) or `vite build` (production). */
export function leakedKeysFor(cwd: string, env: Record<string, string | undefined>): string[] {
  const names = new Set(leakedViteKeys(env));
  for (const mode of ["development", "production"]) for (const k of leakedViteKeys(loadEnv(mode, cwd, "VITE_"))) names.add(k);
  return [...names].sort();
}

export interface CliGateInput {
  leaked: string[];
  ci: boolean;
  dryRun: boolean;
  sync: boolean;
  network: string;
  cap?: string;
}

/** The first reason to refuse this run, or null. --dry-run and --sync never send. */
export function cliGateError(o: CliGateInput): string | null {
  if (o.leaked.length > 0) return leakMessage(o.leaked);
  const sends = !o.dryRun && !o.sync;
  if (o.ci && sends) return "sending from CI is disabled; this CLI is for a local, human-held key (use --dry-run or --sync in CI)";
  if (o.network === "mainnet" && sends && (!o.cap || !CAP_PATTERN.test(o.cap.trim())))
    return "mainnet needs --cap <usdc>, a per-batch cap such as --cap 250";
  return null;
}
