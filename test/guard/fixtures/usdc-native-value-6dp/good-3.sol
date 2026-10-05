// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Tickets {
    uint256 public constant PRICE_6DP = 5_000_000; // 5 USDC on the ERC-20 interface

    function buy() external payable {
        // convert the 6-decimal price to the 18-decimal native value
        require(msg.value == PRICE_6DP * 1e12, "wrong price");
    }
}
