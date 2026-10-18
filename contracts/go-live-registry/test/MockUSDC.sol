// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice 6-decimal USDC stand-in. Etched onto 0x3600…0000 in unit tests.
contract MockUSDC {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public returnFalse;

    error InsufficientAllowance(address owner, address spender, uint256 have, uint256 need);
    error InsufficientBalance(address owner, uint256 have, uint256 need);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setReturnFalse(bool value) external {
        returnFalse = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance(from, msg.sender, allowed, amount);
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance(from, bal, amount);
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        return true;
    }
}
