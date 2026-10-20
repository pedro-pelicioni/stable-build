// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Chain check for the deploy script. Mainnet (5042) needs the typed phrase
///         `SEND REAL USDC`. Testnet (5042002) does not. Any other chain id is refused.
///         The phrase matches the payouts starter's mainnet gate.
library MainnetConfirm {
    bytes32 internal constant PHRASE_HASH = keccak256("SEND REAL USDC");

    error MainnetConfirmationRequired();
    error UnexpectedChain(uint256 chainId);

    function check(uint256 chainId, string memory confirm) internal pure {
        if (chainId == 5042) {
            if (keccak256(bytes(confirm)) != PHRASE_HASH) revert MainnetConfirmationRequired();
        } else if (chainId != 5042002) {
            revert UnexpectedChain(chainId);
        }
    }
}
