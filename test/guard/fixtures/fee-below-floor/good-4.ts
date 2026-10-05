// hardhat.config.ts: the in-process network never reaches Arc's mempool.
const config = {
  networks: {
    hardhat: { gasPrice: 0, initialBaseFeePerGas: 0 },
    arcTestnet: { url: "https://rpc.testnet.arc.io", chainId: 5042002 },
  },
};
export default config;
