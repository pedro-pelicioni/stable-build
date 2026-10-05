import { parseAbi } from "viem";

// Memo: https://docs.arc.io/arc/concepts/transaction-memos
// MemoFailed(bytes) wraps the child revert data. It is a custom error: the
// eth_call evidence in test/fixtures/eth-call-results.json shows selector 0xed1966a2.
export const memoAbi = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
  "event BeforeMemo(uint256 indexed memoIndex)",
  "event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)",
  "error MemoFailed(bytes data)",
]);

// Multicall3From: https://docs.arc.io/arc/concepts/batched-transactions
// Only aggregate3 is used. It forwards no native value.
export const multicall3FromAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) returns (Result[] returnData)",
]);

// USDC ERC-20 interface (6 decimals): https://docs.arc.io/arc/references/contract-addresses
// The same Transfer signature is emitted by the native system emitter (18 decimals):
// https://docs.arc.io/arc/references/usdc-system-events
export const usdcAbi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
