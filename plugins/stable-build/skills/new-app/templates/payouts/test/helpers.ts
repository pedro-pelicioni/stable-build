import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  formatTransactionReceipt,
  getAddress,
  keccak256,
  numberToHex,
  stringToHex,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { memoAbi, usdcAbi } from "../src/config/abis";
import { ADDRESSES } from "../src/config/networks";
import { decodeBatchInput, type PlannedRow } from "../src/core/plan";
import type { ExpectedRow } from "../src/core/reconcile";

export const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export interface Fixture {
  source: Record<string, unknown>;
  tx: { hash: Hex; from: Address; to: Address; input: Hex; nonce: Hex };
  receipt: Record<string, unknown>;
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as Fixture;
}

export function fixtureReceipt(name: string): TransactionReceipt {
  return formatTransactionReceipt(loadFixture(name).receipt as never);
}

/** Expected rows reconstructed from the recorded transaction input (the plan the sender used). */
export function expectedFromInput(input: Hex): ExpectedRow[] {
  return decodeBatchInput(input)
    .filter((c) => c.memo?.recipient && c.memo.target.toLowerCase() === ADDRESSES.USDC.toLowerCase())
    .map((c, index) => ({
      index,
      memoId: c.memo!.memoId,
      recipient: c.memo!.recipient!,
      amount6: c.memo!.amount6!,
      callDataHash: keccak256(c.memo!.data),
    }));
}

export const addr = (seed: string): Address => getAddress(`0x${keccak256(stringToHex(seed)).slice(26)}`);

/**
 * Builds a receipt for planned rows with the same log layout as the recorded
 * testnet receipts: BeforeMemo(k), native Transfer (18 dp), USDC Transfer (6 dp),
 * Memo(sender, USDC, callDataHash, memoId, memo, k). test/synthetic.test.ts
 * checks this layout against the recorded fixtures.
 */
export function synthReceipt(opts: {
  from: Address;
  rows: PlannedRow[];
  hash: Hex;
  blockNumber: bigint;
  memoIndexStart?: bigint;
  status?: "success" | "reverted";
  to?: Address;
}): TransactionReceipt {
  const logs: Log[] = [];
  let logIndex = 0;
  let memoIndex = opts.memoIndexStart ?? 1000n;
  const push = (address: Address, topics: Hex[], data: Hex) =>
    logs.push({
      address,
      topics: topics as [Hex, ...Hex[]],
      data,
      blockNumber: opts.blockNumber,
      blockHash: keccak256(numberToHex(opts.blockNumber)),
      transactionHash: opts.hash,
      transactionIndex: 0,
      logIndex: logIndex++,
      removed: false,
    } as Log);
  if (opts.status !== "reverted") {
    for (const row of opts.rows) {
      push(ADDRESSES.MEMO, encodeEventTopics({ abi: memoAbi, eventName: "BeforeMemo", args: { memoIndex } }) as Hex[], "0x");
      const transferTopics = encodeEventTopics({ abi: usdcAbi, eventName: "Transfer", args: { from: opts.from, to: row.recipient } }) as Hex[];
      push(ADDRESSES.NATIVE_USDC_EMITTER, transferTopics, encodeAbiParameters([{ type: "uint256" }], [row.amount6 * 10n ** 12n]));
      push(ADDRESSES.USDC, transferTopics, encodeAbiParameters([{ type: "uint256" }], [row.amount6]));
      push(
        ADDRESSES.MEMO,
        encodeEventTopics({ abi: memoAbi, eventName: "Memo", args: { sender: opts.from, target: ADDRESSES.USDC, memoId: row.memoId } }) as Hex[],
        encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }], [row.callDataHash, row.memoBytes, memoIndex]),
      );
      memoIndex++;
    }
  }
  return {
    transactionHash: opts.hash,
    blockNumber: opts.blockNumber,
    blockHash: keccak256(numberToHex(opts.blockNumber)),
    from: opts.from,
    to: opts.to ?? ADDRESSES.MULTICALL3FROM,
    status: opts.status ?? "success",
    logs,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    gasUsed: 58_000n * BigInt(opts.rows.length),
    effectiveGasPrice: 20_000_000_000n,
    logsBloom: "0x",
    transactionIndex: 0,
    type: "eip1559",
  } as TransactionReceipt;
}

/** Revert data shaped like the recorded eth_call result: MemoFailed(Error(reason)). */
export function memoFailed(reason: string): Hex {
  const inner = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }], errorName: "Error", args: [reason] });
  return encodeErrorResult({ abi: memoAbi, errorName: "MemoFailed", args: [inner] });
}

/** An error object shaped like viem's call errors (revert data in the cause chain). */
export function revertError(data: Hex): Error {
  const cause = Object.assign(new Error("execution reverted"), { code: 3, data });
  return Object.assign(new Error("Execution reverted"), { cause });
}
