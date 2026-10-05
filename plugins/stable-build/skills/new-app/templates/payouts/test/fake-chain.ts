import { decodeFunctionData, getAddress, keccak256, numberToHex, type Address, type Hex, type Log, type TransactionReceipt } from "viem";
import { memoAbi, multicall3FromAbi, usdcAbi } from "../src/config/abis";
import { ADDRESSES } from "../src/config/networks";
import type { ChainPort, SenderPort, TxRequest } from "../src/core/chain";
import type { PlannedRow } from "../src/core/plan";
import { memoFailed, revertError, synthReceipt } from "./helpers";

interface DecodedRow {
  recipient: Address;
  amount6: bigint;
  memoId: Hex;
  memoBytes: Hex;
  transferData: Hex;
}

function decodeRows(to: Address, data: Hex): DecodedRow[] {
  const memoCalls: Hex[] = [];
  if (to.toLowerCase() === ADDRESSES.MULTICALL3FROM.toLowerCase()) {
    const outer = decodeFunctionData({ abi: multicall3FromAbi, data });
    for (const c of outer.args[0]) memoCalls.push(c.callData);
  } else if (to.toLowerCase() === ADDRESSES.MEMO.toLowerCase()) memoCalls.push(data);
  else throw new Error(`unexpected target ${to}`);
  return memoCalls.map((cd) => {
    const m = decodeFunctionData({ abi: memoAbi, data: cd });
    const [, transferData, memoId, memoBytes] = m.args;
    const t = decodeFunctionData({ abi: usdcAbi, data: transferData });
    return { recipient: t.args[0], amount6: t.args[1], memoId, memoBytes, transferData };
  });
}

/** In-memory Arc-like chain for engine tests. It mines one block per send and
 * produces receipts with the recorded log layout (see test/helpers.ts). */
export class FakeChain implements ChainPort {
  id = 5042002;
  head = 1_000_000n;
  gasLimit = 30_000_000n;
  baseFee = 20_000_000_000n;
  balances = new Map<string, bigint>();
  codes = new Map<string, Hex>();
  blocklist = new Set<string>();
  receipts = new Map<string, TransactionReceipt>();
  memoLogStore: Log[] = [];
  nonces = new Map<string, number>();
  txs = new Map<string, { nonce: number }>();
  /** Makes the next mined transaction revert even though it simulated fine. */
  revertNext = false;
  /** Pretend the RPC does not know this transaction yet (dropped/pending). */
  forget = new Set<string>();
  calls = { call: 0, estimate: 0, getLogs: 0 };
  private memoIndex = 5000n;

  fund(address: Address, amount18: bigint) {
    this.balances.set(address.toLowerCase(), amount18);
  }

  async chainId() {
    return this.id;
  }
  async getCode(address: Address) {
    return this.codes.get(address.toLowerCase()) ?? "0x";
  }
  async getBalance(address: Address) {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }
  async getLatestBlock() {
    return { number: this.head, gasLimit: this.gasLimit, baseFeePerGas: this.baseFee };
  }

  private check(from: Address, rows: DecodedRow[]) {
    let balance = this.balances.get(from.toLowerCase()) ?? 0n;
    for (const r of rows) {
      if (this.blocklist.has(r.recipient.toLowerCase())) throw revertError(memoFailed("Blacklistable: account is blacklisted (fake)"));
      const need = r.amount6 * 10n ** 12n;
      if (balance < need) throw revertError(memoFailed("ERC20: transfer amount exceeds balance"));
      balance -= need;
    }
  }

  async call(tx: { from: Address; to: Address; data: Hex }) {
    this.calls.call++;
    this.check(tx.from, decodeRows(tx.to, tx.data));
    return "0x" as Hex;
  }
  async estimateGas(tx: { from: Address; to: Address; data: Hex }) {
    this.calls.estimate++;
    const rows = decodeRows(tx.to, tx.data);
    this.check(tx.from, rows);
    return 21_000n + 58_000n * BigInt(rows.length);
  }
  async getTransactionReceipt(hash: Hex) {
    if (this.forget.has(hash)) return null;
    return this.receipts.get(hash) ?? null;
  }
  async waitForReceipt(hash: Hex) {
    const r = this.receipts.get(hash);
    if (!r) throw new Error(`no receipt for ${hash}`);
    return r;
  }
  async getTransaction(hash: Hex) {
    if (this.forget.has(hash)) return null;
    const t = this.txs.get(hash);
    return t ? { nonce: t.nonce, blockNumber: this.receipts.get(hash)?.blockNumber ?? null } : null;
  }
  async getTransactionCount(address: Address, _blockTag?: "latest" | "pending") {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }
  memoLogs(sender: Address) {
    return async (fromBlock: bigint, toBlock: bigint) => {
      this.calls.getLogs++;
      if (toBlock - fromBlock + 1n > 9_999n) throw Object.assign(new Error("requested range too large"), { code: -32012 });
      return this.memoLogStore.filter(
        (l) =>
          (l.blockNumber as bigint) >= fromBlock &&
          (l.blockNumber as bigint) <= toBlock &&
          (l.topics[1] as string).toLowerCase().endsWith(sender.slice(2).toLowerCase()),
      );
    };
  }

  /** Mines a transaction: one block, balances move, Memo logs are indexed. */
  mine(from: Address, tx: TxRequest): Hex {
    const nonce = this.nonces.get(from.toLowerCase()) ?? 0;
    if (tx.nonce !== undefined && tx.nonce !== nonce) throw new Error(`nonce ${tx.nonce} does not match the account nonce ${nonce}`);
    this.nonces.set(from.toLowerCase(), nonce + 1);
    this.head += 1n;
    const hash = keccak256(numberToHex(this.head * 1000n + BigInt(nonce)));
    const decoded = decodeRows(tx.to, tx.data);
    let status: "success" | "reverted" = "success";
    try {
      if (this.revertNext) throw new Error("forced revert");
      this.check(from, decoded);
    } catch {
      status = "reverted";
    }
    this.revertNext = false;
    const rows = decoded.map((d) => ({ ...d, callDataHash: keccak256(d.transferData) })) as unknown as PlannedRow[];
    const receipt = synthReceipt({ from: getAddress(from), rows, hash, blockNumber: this.head, memoIndexStart: this.memoIndex, status, to: tx.to });
    if (status === "success") {
      this.memoIndex += BigInt(rows.length);
      const spent = decoded.reduce((s, d) => s + d.amount6 * 10n ** 12n, 0n);
      this.balances.set(from.toLowerCase(), (this.balances.get(from.toLowerCase()) ?? 0n) - spent);
      this.memoLogStore.push(...receipt.logs.filter((l) => l.address.toLowerCase() === ADDRESSES.MEMO.toLowerCase() && l.topics.length === 4));
    }
    this.receipts.set(hash, receipt);
    this.txs.set(hash, { nonce });
    return hash;
  }
}

export class FakeSender implements SenderPort {
  sent: TxRequest[] = [];
  /** Like a local key: signs with the nonce it is given. */
  controlsNonce = true;
  constructor(
    public account: Address,
    private chain: FakeChain,
  ) {}
  async send(tx: TxRequest) {
    if (tx.maxFeePerGas < 20_000_000_000n) throw new Error("fee below the 20 gwei floor");
    this.sent.push(tx);
    return this.chain.mine(this.account, tx);
  }
}
