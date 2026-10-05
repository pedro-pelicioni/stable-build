// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct Call3 { address target; bool allowFailure; bytes callData; }

interface IMulticall3From {
    function aggregate3(Call3[] calldata calls) external payable returns (bytes[] memory);
}

library Batch {
    function run(Call3[] calldata calls) internal {
        IMulticall3From(0x522fAf9A91c41c443c66765030741e4AaCe147D0).aggregate3{value: msg.value}(calls);
    }
}
