// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DemoProject, GoLiveRegistry} from "../src/GoLiveRegistry.sol";

interface ForkVm {
    function envString(string calldata) external view returns (string memory);
    function skip(bool) external;
    function createSelectFork(string calldata) external returns (uint256);
    function deal(address, uint256) external;
    function addr(uint256) external pure returns (address);
    function sign(uint256, bytes32) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
}

interface IUsdcView {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

address constant FORK_VM = address(uint160(uint256(keccak256("hevm cheat code"))));

/// @notice Forks Arc mainnet only when ARC_MAINNET_RPC is set. No transaction is broadcast
///         and no real USDC is spent: balances below come from the `deal` cheatcode.
contract ArcForkTest {
    ForkVm internal constant vm = ForkVm(FORK_VM);
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant ANVIL_TEST_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    error ForkAssert(uint256 a, uint256 b);

    function setUp() public {
        string memory rpc;
        try vm.envString("ARC_MAINNET_RPC") returns (string memory value) {
            rpc = value;
        } catch {
            rpc = "";
        }
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
    }

    function testFork_chainCodeAndSixDecimals() public view {
        if (block.chainid != 5042) revert ForkAssert(block.chainid, 5042);
        if (USDC.code.length == 0) revert ForkAssert(0, 1);
        if (IUsdcView(USDC).decimals() != 6) revert ForkAssert(IUsdcView(USDC).decimals(), 6);
    }

    /// @dev Funds the registrant with cheatcode balances, then registers. The 6-decimal
    ///      fee is what `balanceOf` moves. Native `deal` is 18-decimal units of the same
    ///      token; this test does not add the two views together.
    function testFork_registerPullsSixDecimalFee() public {
        address verifier = vm.addr(ANVIL_TEST_KEY);
        address treasury = address(0xBEEF);
        address registrant = address(0xCAFE);
        GoLiveRegistry reg = new GoLiveRegistry(address(this), verifier, treasury, 10_000);
        address project = address(new DemoProject());

        // 1 USDC on the native view (18 decimals) so a 0.01 USDC fee (10_000 at 6 decimals) fits.
        vm.deal(registrant, 1_000_000_000_000_000_000);
        vm.startPrank(registrant);
        IUsdcView(USDC).approve(address(reg), 10_000);
        vm.stopPrank();

        bytes32 report = keccak256("fork-report");
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 digest = reg.hashRegistration(address(reg), block.chainid, project, block.chainid, report, 1, expiry, 1, 10_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ANVIL_TEST_KEY, digest);
        uint256 beforeTreasury = IUsdcView(USDC).balanceOf(treasury);
        vm.prank(registrant);
        reg.register(project, block.chainid, report, 1, expiry, 1, 10_000, abi.encodePacked(r, s, v));
        uint256 afterTreasury = IUsdcView(USDC).balanceOf(treasury);
        if (afterTreasury - beforeTreasury != 10_000) revert ForkAssert(afterTreasury - beforeTreasury, 10_000);
        if (!reg.hasBadge(project)) revert ForkAssert(0, 1);
    }
}
