import { getAddress, type Address } from "viem";
// The signer is plain JavaScript. parsePayload checks the object it returns.
// @ts-expect-error module has no declaration file
import { buildPayload } from "../../../tools/go-live-sign.mjs";

/** Anvil's published account 0. Public test key, same as the registry tests. Not a secret. */
export const ANVIL_TEST_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const REGISTRY: Address = getAddress("0x1111111111111111111111111111111111111111");
export const PROJECT: Address = getAddress("0x2222222222222222222222222222222222222222");

export function signedPayload(over: { chainId?: bigint; fee?: bigint; registry?: Address; project?: Address } = {}) {
  const statuses: Record<string, string> = {};
  for (let i = 1; i <= 14; i++) statuses[`G${i}`] = "pass";
  return buildPayload({
    project: over.project ?? PROJECT,
    registry: over.registry ?? REGISTRY,
    chainId: over.chainId ?? 5042002n,
    expiry: 1893456000n,
    nonce: 1n,
    fee: over.fee ?? 10_000n,
    reportBytes: Buffer.from("stable-build onboarding test report"),
    reportHashSource: "test",
    statuses,
    privateKey: ANVIL_TEST_KEY,
    allowPartial: false,
  });
}
