import {
  concat,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  recoverAddress,
  stringToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { registryAbi, usdcAbi } from "../config/abis";
import {
  GATE_MASK,
  MAX_FEE,
  REGISTRY_NAME,
  REGISTRY_VERSION,
  USDC,
  USDC_DECIMALS,
} from "../config/networks";

const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const REGISTRATION_TYPE =
  "Registration(address project,uint256 chainId,bytes32 reportHash,uint16 gates,uint64 expiry,uint256 nonce,uint256 fee)";

const DOMAIN_TYPEHASH = keccak256(stringToBytes(DOMAIN_TYPE));
const REGISTRATION_TYPEHASH = keccak256(stringToBytes(REGISTRATION_TYPE));
const NAME_HASH = keccak256(stringToBytes(REGISTRY_NAME));
const VERSION_HASH = keccak256(stringToBytes(REGISTRY_VERSION));

/** secp256k1n / 2. A larger `s` is the malleable twin. */
const SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export interface Calldata {
  to: Address;
  data: Hex;
  value: "0";
}

export interface ValidPayload {
  purpose: "GoLiveRegistry.register";
  usdc: Address;
  usdcDecimals: 6;
  nativeValue: "0";
  fee: bigint;
  domain: {
    name: typeof REGISTRY_NAME;
    version: typeof REGISTRY_VERSION;
    chainId: bigint;
    verifyingContract: Address;
  };
  message: {
    project: Address;
    chainId: bigint;
    reportHash: Hex;
    gates: number;
    expiry: bigint;
    nonce: bigint;
    fee: bigint;
  };
  verifier: Address;
  signature: Hex;
  digest: Hex;
  approve: Calldata | null;
  register: Calldata;
}

export class PayloadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PayloadError";
    this.code = code;
  }
}

export interface PayloadContext {
  chainId: number;
  registry: Address;
}

/** EIP-712 digest. `gates`, `expiry` and `fee` are encoded as uint256, matching `abi.encode`. */
export function hashRegistration(p: {
  verifyingContract: Address;
  domainChainId: bigint;
  project: Address;
  chainId: bigint;
  reportHash: Hex;
  gates: bigint;
  expiry: bigint;
  nonce: bigint;
  fee: bigint;
}): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, p.domainChainId, p.verifyingContract],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [REGISTRATION_TYPEHASH, p.project, p.chainId, p.reportHash, p.gates, p.expiry, p.nonce, p.fee],
    ),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

export function encodeApprove(registry: Address, fee: bigint): Hex {
  return encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [registry, fee] });
}

export function encodeRegister(message: ValidPayload["message"], signature: Hex): Hex {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "register",
    args: [
      message.project,
      message.chainId,
      message.reportHash,
      message.gates,
      message.expiry,
      message.nonce,
      message.fee,
      signature,
    ],
  });
}

function fail(code: string, message: string): never {
  throw new PayloadError(code, message);
}

function asObject(value: unknown, code: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function uintString(value: unknown, code: string, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) fail(code, `${label} must be a non-negative integer string`);
  return BigInt(value);
}

function addressOf(value: unknown, code: string, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) fail(code, `${label} must be an address`);
  return getAddress(value);
}

function hexOf(value: unknown, bytes: number, code: string, label: string): Hex {
  if (typeof value !== "string" || !isHex(value)) fail(code, `${label} must be hex`);
  const raw = hexToBytes(value);
  if (raw.length !== bytes) fail(code, `${label} must be ${bytes} bytes`);
  return value.toLowerCase() as Hex;
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function readCall(value: unknown, label: string): Calldata {
  const call = asObject(value, "calldata", label);
  const to = addressOf(call.to, "calldata", `${label}.to`);
  if (typeof call.data !== "string" || !isHex(call.data) || call.data.length < 10) {
    fail("calldata", `${label}.data must be calldata`);
  }
  if (call.value !== "0") fail("native-value", `${label}.value must be "0"`);
  return { to, data: call.data as Hex, value: "0" };
}

/**
 * Accept the JSON printed by `tools/go-live-sign.mjs`.
 * Rejects an unsigned payload, a fee above 10 USDC, 18-decimal amounts, native value,
 * a chain id other than `ctx.chainId`, and calldata that does not match the signed fields.
 */
export async function parsePayload(json: unknown, ctx: PayloadContext): Promise<ValidPayload> {
  const root = asObject(json, "shape", "payload");
  if (root.purpose !== "GoLiveRegistry.register") fail("purpose", 'purpose must be "GoLiveRegistry.register"');
  const usdc = addressOf(root.usdc, "usdc", "usdc");
  if (usdc !== getAddress(USDC)) fail("usdc", "usdc must be the ERC-20 interface at 0x3600…0000");
  if (root.usdcDecimals !== USDC_DECIMALS) {
    fail("decimals", `usdcDecimals must be ${USDC_DECIMALS}; the native view uses 18 and is not accepted`);
  }
  if (root.nativeValue !== "0") fail("native-value", 'nativeValue must be "0"');

  const fee = uintString(root.fee, "fee", "fee");
  if (fee > MAX_FEE) fail("fee", `fee ${fee} is above ${MAX_FEE} (10 USDC, 6 decimals)`);

  const domain = asObject(root.domain, "domain", "domain");
  if (domain.name !== REGISTRY_NAME || domain.version !== REGISTRY_VERSION) {
    fail("domain", `domain must be ${REGISTRY_NAME} version ${REGISTRY_VERSION}`);
  }
  const domainChainId = uintString(domain.chainId, "chain", "domain.chainId");
  const registry = addressOf(domain.verifyingContract, "domain", "domain.verifyingContract");
  if (registry !== getAddress(ctx.registry)) fail("registry", "domain.verifyingContract does not match VITE_REGISTRY_ADDRESS");
  if (domainChainId !== BigInt(ctx.chainId)) {
    fail("chain", `payload chain id ${domainChainId} does not match this app (${ctx.chainId})`);
  }

  const message = asObject(root.message, "message", "message");
  const project = addressOf(message.project, "message", "message.project");
  const messageChainId = uintString(message.chainId, "chain", "message.chainId");
  if (messageChainId !== domainChainId) fail("chain", "message.chainId does not match the domain");
  const reportHash = hexOf(message.reportHash, 32, "report", "message.reportHash");
  if (reportHash === `0x${"00".repeat(32)}`) fail("report", "report hash is empty");
  const gates = uintString(message.gates, "gates", "message.gates");
  if (gates === 0n || gates > BigInt(GATE_MASK)) fail("gates", "gates must set at least one of bits 0..13 and no higher bit");
  const expiry = uintString(message.expiry, "message", "message.expiry");
  const nonce = uintString(message.nonce, "message", "message.nonce");
  const messageFee = uintString(message.fee, "fee", "message.fee");
  if (messageFee !== fee) fail("fee", "message.fee does not match payload.fee");

  if (root.signed !== true) fail("unsigned", "payload is not signed; run go-live-sign.mjs with STABLE_BUILD_VERIFIER_KEY");
  const signature = hexOf(root.signature, 65, "signature", "signature");
  const bytes = hexToBytes(signature);
  let s = 0n;
  for (const b of bytes.subarray(32, 64)) s = (s << 8n) | BigInt(b);
  let v = bytes[64] ?? 0;
  if (v < 27) v += 27;
  if ((v !== 27 && v !== 28) || s === 0n || s > SECP256K1N_HALF) fail("signature", "signature must be 65 bytes with a low s and v of 27 or 28");

  const verifier = addressOf(root.verifier, "verifier", "verifier");
  const digest = hashRegistration({
    verifyingContract: registry,
    domainChainId,
    project,
    chainId: messageChainId,
    reportHash,
    gates,
    expiry,
    nonce,
    fee,
  });
  if (typeof root.digest === "string" && !sameHex(root.digest, digest)) fail("digest", "payload digest does not match the signed fields");

  const recovered = getAddress(await recoverAddress({ hash: digest, signature }));
  if (recovered === zeroAddress || recovered !== verifier) fail("signature", "signature did not recover to the verifier");

  const parsedMessage = {
    project,
    chainId: messageChainId,
    reportHash,
    gates: Number(gates),
    expiry,
    nonce,
    fee,
  };
  const registerData = encodeRegister(parsedMessage, signature);
  const register = readCall(root.register, "register");
  if (register.to !== registry) fail("calldata", "register.to must be the registry");
  if (!sameHex(register.data, registerData)) fail("calldata", "register.data does not match the signed fields");

  let approve: Calldata | null = null;
  if (fee > 0n) {
    if (root.approve == null) fail("calldata", "approve is missing");
    approve = readCall(root.approve, "approve");
    if (approve.to !== usdc) fail("calldata", "approve.to must be the USDC ERC-20");
    const expected = encodeApprove(registry, fee);
    if (!sameHex(approve.data, expected)) fail("calldata", "approve.data is not approve(registry, fee) for the signed fee");
  } else if (root.approve != null) {
    fail("calldata", "a zero fee has no approve transaction");
  }

  return {
    purpose: "GoLiveRegistry.register",
    usdc,
    usdcDecimals: 6,
    nativeValue: "0",
    fee,
    domain: { name: REGISTRY_NAME, version: REGISTRY_VERSION, chainId: domainChainId, verifyingContract: registry },
    message: parsedMessage,
    verifier,
    signature,
    digest,
    approve,
    register,
  };
}

/** Name of a registry custom error, or null when `data` is not one of them. */
export function registryErrorName(data: Hex | null | undefined): string | null {
  if (!data || data === "0x" || data.length < 10) return null;
  try {
    return decodeErrorResult({ abi: registryAbi, data }).errorName;
  } catch {
    return null;
  }
}
