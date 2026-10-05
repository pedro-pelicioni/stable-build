// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITokenMessengerV2 {
    function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken,
        bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external;
}

contract StellarPayout {
    uint32 constant STELLAR_DOMAIN = 27;

    function send(ITokenMessengerV2 messenger, address usdc, uint256 amount, bytes32 recipient) external {
        messenger.depositForBurn(amount, STELLAR_DOMAIN, recipient, usdc, bytes32(0), 0, 2000);
    }
}
