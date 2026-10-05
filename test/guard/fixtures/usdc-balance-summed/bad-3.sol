// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Vault {
    IERC20 public immutable usdc = IERC20(0x3600000000000000000000000000000000000000);

    function totalAssets() public view returns (uint256) {
        return address(this).balance + usdc.balanceOf(address(this));
    }
}
