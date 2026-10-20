import { parseAbi } from "viem";

// USDC ERC-20 interface, 6 decimals.
// Source: https://docs.arc.io/arc/references/contract-addresses
// The native view of the same balance is 18 decimals and is not used here.
export const usdcAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const registryAbi = parseAbi([
  "function fee() view returns (uint256)",
  "function hasBadge(address project) view returns (bool)",
  "function badgeOf(address project) view returns ((address project, uint256 chainId, bytes32 reportHash, uint16 gates, uint64 expiry, uint64 registeredAt, address registrant, uint256 nonce))",
  "function register(address project, uint256 chainId, bytes32 reportHash, uint16 gates, uint64 expiry, uint256 nonce, uint256 signedFee, bytes signature) returns (bytes32 digest)",
  "error OwnableUnauthorized(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error ZeroAddress()",
  "error FeeTooHigh(uint256 fee)",
  "error BadGates(uint16 gates)",
  "error Expired(uint64 expiry, uint256 nowTs)",
  "error WrongChain(uint256 chainId, uint256 expected)",
  "error NoCode(address project)",
  "error EmptyReport()",
  "error BadSignature()",
  "error Replay(bytes32 digest)",
  "error FeeMismatch(uint256 signedFee, uint256 fee)",
  "error NotVerifier(address signer)",
  "error FeeTransferFailed()",
  "error NativeValueRejected()",
]);
