import { strkeyToBytes32, forwardHookData } from "./stellar";

const STELLAR_DOMAIN = 27;
const CCTP_FORWARDER = {
  mainnet: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
  testnet: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
} as const;

export function burnParams(amount: bigint, recipientStrkey: string, network: "mainnet" | "testnet") {
  const forwarder = strkeyToBytes32(CCTP_FORWARDER[network]);
  return {
    amount,
    destinationDomain: STELLAR_DOMAIN,
    mintRecipient: forwarder,
    destinationCaller: forwarder,
    hookData: forwardHookData(recipientStrkey),
  };
}
