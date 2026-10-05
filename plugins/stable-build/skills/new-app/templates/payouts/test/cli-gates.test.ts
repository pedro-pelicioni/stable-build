import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cliGateError, leakedKeysFor } from "../scripts/cli-gates";

const KEY = `0x${"cd".repeat(32)}`;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "payout-gates-"));
  dirs.push(d);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
};
const base = { leaked: [], ci: false, dryRun: false, sync: false, network: "testnet" };

describe("CLI gates", () => {
  it("finds a key in .env files, not only in the shell environment", () => {
    expect(leakedKeysFor(project({ ".env": `VITE_DEPLOYER_KEY=${KEY}\n` }), {})).toEqual(["VITE_DEPLOYER_KEY"]);
    expect(leakedKeysFor(project({ ".env.production.local": `VITE_X=${KEY}\n` }), {})).toEqual(["VITE_X"]);
    expect(leakedKeysFor(project({}), { VITE_SHELL: KEY })).toEqual(["VITE_SHELL"]);
    expect(leakedKeysFor(project({ ".env": "VITE_NETWORK=testnet\nPAYOUT_PRIVATE_KEY=" + KEY + "\n" }), {})).toEqual([]);
  });

  it("refuses a leaked key before anything else, even for a dry run", () => {
    expect(cliGateError({ ...base, dryRun: true, leaked: ["VITE_X"] })).toMatch(/VITE_X looks like a private key/);
  });

  it("refuses to send from CI, but allows --dry-run and --sync there", () => {
    expect(cliGateError({ ...base, ci: true })).toMatch(/CI is disabled/);
    expect(cliGateError({ ...base, ci: true, dryRun: true })).toBeNull();
    expect(cliGateError({ ...base, ci: true, sync: true })).toBeNull();
  });

  it("requires a well-formed cap for mainnet sends only", () => {
    const mainnet = { ...base, network: "mainnet" };
    expect(cliGateError(mainnet)).toMatch(/--cap/);
    for (const cap of ["", "abc", "1.1234567", "-5", "1e3"]) expect(cliGateError({ ...mainnet, cap })).toMatch(/--cap/);
    for (const cap of ["250", "0.5", "10.123456", " 7 "]) expect(cliGateError({ ...mainnet, cap })).toBeNull();
    expect(cliGateError({ ...mainnet, dryRun: true })).toBeNull();
    expect(cliGateError({ ...mainnet, sync: true })).toBeNull();
    expect(cliGateError({ ...base })).toBeNull();
  });
});
