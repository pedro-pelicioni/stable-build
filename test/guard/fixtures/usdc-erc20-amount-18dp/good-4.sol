// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {IERC20} from "./IERC20.sol";
contract WadVault {
    IERC20 public usdc;
    uint256 public pricePerShare; // 1e18-scaled
    function redeem(uint256 shares) external {
        usdc.transfer(msg.sender, shares * pricePerShare / 1e18);
    }
}
