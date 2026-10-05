// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Tickets {
    uint256 public constant PRICE = 5; // whole USDC

    function buy() external payable {
        // msg.value is native USDC with 18 decimals on Arc
        require(msg.value == PRICE * 1e6, "wrong price");
    }
}
