import { zeroHash } from "viem";
import { strkeyToBytes32 } from "./stellar";

// Forwarder is the mint recipient, but the destination caller is left empty.
const CCTP_FORWARDER_TESTNET = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";

export function burnParams(amount: bigint) {
  return {
    amount,
    destinationDomain: 27,
    mintRecipient: strkeyToBytes32(CCTP_FORWARDER_TESTNET),
    destinationCaller: zeroHash,
  };
}
