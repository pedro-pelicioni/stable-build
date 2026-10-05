// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

interface IMemo {
    function memo(address target, bytes calldata data, bytes32 memoId, bytes calldata memoData) external;
}

// A forge script broadcasts each call as an EOA transaction, so the caller is the EOA.
contract SendMemo is Script {
    function run(address usdc, bytes calldata data, bytes32 id) external {
        vm.startBroadcast();
        IMemo(0x5294E9927c3306DcBaDb03fe70b92e01cCede505).memo(usdc, data, id, "");
        vm.stopBroadcast();
    }
}
