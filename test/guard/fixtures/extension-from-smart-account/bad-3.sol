// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMemo {
    function memo(address target, bytes calldata data, bytes32 memoId, bytes calldata memoData) external;
}

contract Treasury {
    IMemo constant MEMO = IMemo(0x5294E9927c3306DcBaDb03fe70b92e01cCede505);

    function payWithMemo(address usdc, bytes calldata data, bytes32 id) external {
        MEMO.memo(usdc, data, id, "");
    }
}
