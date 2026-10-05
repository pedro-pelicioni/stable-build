// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Payroll {
    IERC20 public immutable usdc = IERC20(0x3600000000000000000000000000000000000000);

    function payOne(address to, uint256 wholeUsdc) external {
        usdc.transfer(to, wholeUsdc * 1e6);
    }
}
