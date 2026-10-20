// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DemoProject, GoLiveRegistry} from "../src/GoLiveRegistry.sol";
import {MainnetConfirm} from "../src/MainnetConfirm.sol";

interface DeployVm {
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
    function addr(uint256 privateKey) external pure returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Deploy `GoLiveRegistry`. The shell wrapper dry-runs unless `--broadcast` is passed.
///         Keys come from the environment and are not written into this file.
///         STABLE_BUILD_DEPLOYER_KEY, STABLE_BUILD_VERIFIER, STABLE_BUILD_TREASURY,
///         optional STABLE_BUILD_FEE (6-decimal base units, default 10000 = 0.01 USDC),
///         and on chain 5042 STABLE_BUILD_MAINNET_CONFIRM=`SEND REAL USDC`.
contract DeployGoLiveRegistry {
    DeployVm private constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Empty project deployed in the same transaction set, for the owner's first registration.
    DemoProject public demo;

    function run() external returns (GoLiveRegistry registry) {
        string memory confirm = vm.envOr("STABLE_BUILD_MAINNET_CONFIRM", string(""));
        MainnetConfirm.check(block.chainid, confirm);

        uint256 pk = vm.envUint("STABLE_BUILD_DEPLOYER_KEY");
        address verifier = vm.envAddress("STABLE_BUILD_VERIFIER");
        address treasury = vm.envAddress("STABLE_BUILD_TREASURY");
        uint256 regFee = vm.envOr("STABLE_BUILD_FEE", uint256(10_000));

        vm.startBroadcast(pk);
        // The demo project is the address the owner registers. The registry only checks that it has code.
        demo = new DemoProject();
        registry = new GoLiveRegistry(vm.addr(pk), verifier, treasury, regFee);
        vm.stopBroadcast();
    }
}
