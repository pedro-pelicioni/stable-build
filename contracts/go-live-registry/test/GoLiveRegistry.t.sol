// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DemoProject, GoLiveRegistry} from "../src/GoLiveRegistry.sol";
import {MainnetConfirm} from "../src/MainnetConfirm.sol";
import {MockUSDC} from "./MockUSDC.sol";

interface TestVm {
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function warp(uint256) external;
    function chainId(uint256) external;
    function prank(address) external;
    function etch(address, bytes calldata) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function parseJsonAddress(string calldata, string calldata) external pure returns (address);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
}

address constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));

/// @notice Unit tests. USDC is a mock etched at the real ERC-20 address. No native value is sent.
contract GoLiveRegistryTest {
    TestVm internal constant vm = TestVm(VM_ADDRESS);

    // Anvil's published account 0. A public test key, not a secret.
    uint256 internal constant ANVIL_TEST_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    address internal constant USDC = 0x3600000000000000000000000000000000000000;

    uint256 internal constant NOW = 1_700_000_000;
    uint16 internal constant ALL_GATES = 0x3FFF;
    uint256 internal constant FEE = 10_000;

    event Registered(
        address indexed project,
        address indexed registrant,
        bytes32 indexed reportHash,
        uint16 gates,
        uint64 expiry,
        uint256 nonce,
        uint256 fee
    );
    event VerifierSet(address indexed previousVerifier, address indexed verifier);
    event FeeSet(uint256 previousFee, uint256 fee);
    event TreasurySet(address indexed previousTreasury, address indexed treasury);

    error EqU(uint256 a, uint256 b);
    error EqB(bytes32 a, bytes32 b);
    error EqA(address a, address b);

    GoLiveRegistry internal reg;
    MockUSDC internal usdc;
    address internal project;
    address internal verifier;
    address internal treasury;
    address internal registrant;

    function setUp() public {
        vm.chainId(5042);
        vm.warp(NOW);
        verifier = vm.addr(ANVIL_TEST_KEY);
        treasury = address(0xBEEF);
        registrant = address(0xCAFE);
        reg = new GoLiveRegistry(address(this), verifier, treasury, FEE);
        MockUSDC impl = new MockUSDC();
        vm.etch(USDC, address(impl).code);
        usdc = MockUSDC(USDC);
        project = address(new DemoProject());
    }

    function test_happyPath_feeEventsAndListing() public {
        bytes32 report = keccak256("report-v1");
        uint64 expiry = uint64(NOW + 30 days);
        _fund(registrant, FEE);
        bytes memory signature = _sign(project, report, ALL_GATES, expiry, 1);

        vm.expectEmit(true, true, true, true);
        emit Registered(project, registrant, report, ALL_GATES, expiry, 1, FEE);
        vm.prank(registrant);
        bytes32 digest = reg.register(project, block.chainid, report, ALL_GATES, expiry, 1, FEE, signature);

        GoLiveRegistry.Badge memory b = reg.badgeOf(project);
        if (b.project != project) revert EqA(b.project, project);
        if (b.reportHash != report) revert EqB(b.reportHash, report);
        if (b.gates != ALL_GATES) revert EqU(b.gates, ALL_GATES);
        if (b.registrant != registrant) revert EqA(b.registrant, registrant);
        if (b.registeredAt != NOW) revert EqU(b.registeredAt, NOW);
        if (b.nonce != 1) revert EqU(b.nonce, 1);
        if (!reg.hasBadge(project)) revert EqU(1, 0);
        if (reg.projectCount() != 1) revert EqU(reg.projectCount(), 1);
        if (reg.projectAt(0) != project) revert EqA(reg.projectAt(0), project);
        if (usdc.balanceOf(treasury) != FEE) revert EqU(usdc.balanceOf(treasury), FEE);
        if (usdc.balanceOf(registrant) != 0) revert EqU(usdc.balanceOf(registrant), 0);
        if (usdc.decimals() != 6) revert EqU(usdc.decimals(), 6);
        if (address(reg).balance != 0) revert EqU(address(reg).balance, 0);
        if (!reg.usedDigest(digest)) revert EqU(1, 0);

        GoLiveRegistry.Badge[] memory page = reg.list(0, 10);
        if (page.length != 1) revert EqU(page.length, 1);
        if (page[0].reportHash != report) revert EqB(page[0].reportHash, report);
    }

    function test_decimalsStayAtSixWhenFeeChanges() public {
        // 20_000 base units is 0.02 USDC, still 6 decimals, not 20_000 * 10^12.
        reg.setFee(20_000);
        bytes32 report = keccak256("fee");
        uint64 expiry = uint64(NOW + 1 days);
        _fund(registrant, 20_000);
        bytes memory signature = _sign(project, report, ALL_GATES, expiry, 7);
        vm.prank(registrant);
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 7, 20_000, signature);
        if (usdc.decimals() != 6) revert EqU(usdc.decimals(), 6);
        if (usdc.balanceOf(treasury) != 20_000) revert EqU(usdc.balanceOf(treasury), 20_000);
    }

    function test_badSigner() public {
        uint256 other = uint256(keccak256("not-the-verifier"));
        bytes32 report = keccak256("bad-signer");
        uint64 expiry = uint64(NOW + 1 days);
        _fund(registrant, FEE);
        bytes32 digest = reg.hashRegistration(address(reg), block.chainid, project, block.chainid, report, ALL_GATES, expiry, 2, FEE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(other, digest);
        vm.prank(registrant);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.NotVerifier.selector, vm.addr(other)));
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 2, FEE, abi.encodePacked(r, s, v));
    }

    function test_expired() public {
        bytes32 report = keccak256("expired");
        uint64 expiry = uint64(NOW + 100);
        bytes memory signature = _sign(project, report, ALL_GATES, expiry, 3);
        vm.warp(expiry + 1);
        _fund(registrant, FEE);
        vm.prank(registrant);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.Expired.selector, expiry, expiry + 1));
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 3, FEE, signature);

        // The deadline second itself is still accepted.
        vm.warp(expiry);
        vm.prank(registrant);
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 3, FEE, signature);
        if (reg.badgeOf(project).expiry != expiry) revert EqU(reg.badgeOf(project).expiry, expiry);
    }

    function test_replayIsTheDigestAndNonceIsNotGlobal() public {
        bytes32 report = keccak256("once");
        uint64 expiry = uint64(NOW + 1 days);
        bytes memory signature = _sign(project, report, ALL_GATES, expiry, 4);
        _fund(registrant, FEE * 3);
        vm.prank(registrant);
        bytes32 digest = reg.register(project, block.chainid, report, ALL_GATES, expiry, 4, FEE, signature);
        vm.prank(registrant);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.Replay.selector, digest));
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 4, FEE, signature);

        // The same nonce on another project is a different digest.
        address other = address(new DemoProject());
        bytes memory otherSig = _sign(other, report, ALL_GATES, expiry, 4);
        vm.prank(registrant);
        reg.register(other, block.chainid, report, ALL_GATES, expiry, 4, FEE, otherSig);
        if (reg.badgeOf(other).nonce != 4) revert EqU(reg.badgeOf(other).nonce, 4);

        // The same nonce on this project with a new report is also a new digest.
        bytes32 report2 = keccak256("twice");
        bytes memory signature2 = _sign(project, report2, ALL_GATES, expiry, 4);
        vm.prank(registrant);
        reg.register(project, block.chainid, report2, ALL_GATES, expiry, 4, FEE, signature2);
        if (reg.badgeOf(project).reportHash != report2) revert EqB(reg.badgeOf(project).reportHash, report2);
        if (reg.projectCount() != 2) revert EqU(reg.projectCount(), 2);
    }

    function test_reregisterUpdatesInPlace() public {
        uint64 expiry = uint64(NOW + 1 days);
        _fund(registrant, FEE * 3);
        bytes32 first = keccak256("first");
        bytes memory sigFirst = _sign(project, first, ALL_GATES, expiry, 5);
        vm.prank(registrant);
        reg.register(project, block.chainid, first, ALL_GATES, expiry, 5, FEE, sigFirst);
        address second = address(new DemoProject());
        bytes32 next = keccak256("second");
        bytes memory sigNext = _sign(second, next, 1, expiry, 6);
        vm.prank(registrant);
        reg.register(second, block.chainid, next, 1, expiry, 6, FEE, sigNext);
        bytes32 updated = keccak256("updated");
        bytes memory sigUpdated = _sign(project, updated, 3, expiry, 8);
        vm.prank(registrant);
        reg.register(project, block.chainid, updated, 3, expiry, 8, FEE, sigUpdated);
        if (reg.projectCount() != 2) revert EqU(reg.projectCount(), 2);
        if (reg.badgeOf(project).reportHash != updated) revert EqB(reg.badgeOf(project).reportHash, updated);
        if (reg.list(0, 50).length != 2) revert EqU(reg.list(0, 50).length, 2);
        if (reg.list(1, 100).length != 1) revert EqU(reg.list(1, 100).length, 1);
    }

    function test_wrongChainId() public {
        bytes32 report = keccak256("chain");
        uint64 expiry = uint64(NOW + 1 days);
        uint256 wrong = 5042002;
        bytes32 digest = reg.hashRegistration(address(reg), block.chainid, project, wrong, report, ALL_GATES, expiry, 9, FEE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ANVIL_TEST_KEY, digest);
        _fund(registrant, FEE);
        vm.prank(registrant);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.WrongChain.selector, wrong, block.chainid));
        reg.register(project, wrong, report, ALL_GATES, expiry, 9, FEE, abi.encodePacked(r, s, v));
        if (reg.usedDigest(digest)) revert EqU(1, 0);
    }

    function test_noCode() public {
        address empty = address(0x1234);
        bytes32 report = keccak256("empty");
        uint64 expiry = uint64(NOW + 1 days);
        bytes memory signature = _sign(empty, report, ALL_GATES, expiry, 10);
        _fund(registrant, FEE);
        vm.prank(registrant);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.NoCode.selector, empty));
        reg.register(empty, block.chainid, report, ALL_GATES, expiry, 10, FEE, signature);
    }

    function test_insufficientAllowanceAndBalanceAndFalseReturn() public {
        bytes32 report = keccak256("fee-fail");
        uint64 expiry = uint64(NOW + 1 days);
        bytes memory signature = _sign(project, report, ALL_GATES, expiry, 11);
        usdc.mint(registrant, FEE);
        vm.prank(registrant);
        usdc.approve(address(reg), FEE - 1);
        vm.prank(registrant);
        vm.expectRevert(
            abi.encodeWithSelector(MockUSDC.InsufficientAllowance.selector, registrant, address(reg), FEE - 1, FEE)
        );
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 11, FEE, signature);

        vm.prank(registrant);
        usdc.approve(address(reg), FEE);
        // Drain the balance after the approval so the allowance is enough and the balance is not.
        // mint went to registrant; transfer it away by a direct balance check path: setReturnFalse is separate.
        // The mock has no burn. Register with a second user who approved but was never minted.
        address poor = address(0xF00D);
        vm.prank(poor);
        usdc.approve(address(reg), FEE);
        vm.prank(poor);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.InsufficientBalance.selector, poor, uint256(0), FEE));
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 11, FEE, signature);

        usdc.setReturnFalse(true);
        vm.prank(registrant);
        vm.expectRevert(GoLiveRegistry.FeeTransferFailed.selector);
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 11, FEE, signature);
        bytes32 digest = reg.hashRegistration(address(reg), block.chainid, project, block.chainid, report, ALL_GATES, expiry, 11, FEE);
        if (reg.usedDigest(digest)) revert EqU(1, 0);
    }

    function test_feeChangeVerifierRotationAndTreasury() public {
        if (reg.fee() != FEE) revert EqU(reg.fee(), FEE);
        vm.expectEmit(false, false, false, true);
        emit FeeSet(FEE, 1);
        reg.setFee(1);
        address nextVerifier = vm.addr(uint256(keccak256("next")));
        vm.expectEmit(true, true, false, true);
        emit VerifierSet(verifier, nextVerifier);
        reg.setVerifier(nextVerifier);
        address nextTreasury = address(0x7777);
        vm.expectEmit(true, true, false, true);
        emit TreasurySet(treasury, nextTreasury);
        reg.setTreasury(nextTreasury);

        bytes32 report = keccak256("rotated");
        uint64 expiry = uint64(NOW + 1 days);
        // The old key no longer verifies.
        _fund(registrant, 1);
        bytes memory stale = _sign(project, report, ALL_GATES, expiry, 12);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.NotVerifier.selector, verifier));
        vm.prank(registrant);
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 12, 1, stale);

        bytes32 digest = reg.hashRegistration(address(reg), block.chainid, project, block.chainid, report, ALL_GATES, expiry, 12, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256("next")), digest);
        bytes memory fresh = abi.encodePacked(r, s, v);
        vm.prank(registrant);
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 12, 1, fresh);
        if (usdc.balanceOf(nextTreasury) != 1) revert EqU(usdc.balanceOf(nextTreasury), 1);
        if (usdc.balanceOf(treasury) != 0) revert EqU(usdc.balanceOf(treasury), 0);
    }

    function test_ownerGatesAndZeroFee() public {
        vm.prank(registrant);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.OwnableUnauthorized.selector, registrant));
        reg.setFee(1);
        // Snapshot before expectRevert: the getter is an external call and would consume it.
        uint256 tooHigh = reg.MAX_FEE() + 1;
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.FeeTooHigh.selector, tooHigh));
        reg.setFee(tooHigh);
        vm.expectRevert(GoLiveRegistry.ZeroAddress.selector);
        reg.setVerifier(address(0));
        vm.expectRevert(GoLiveRegistry.ZeroAddress.selector);
        reg.setTreasury(address(0));

        reg.setFee(0);
        bytes32 report = keccak256("free");
        uint64 expiry = uint64(NOW + 1 days);
        bytes memory signature = _sign(project, report, 1, expiry, 13);
        vm.prank(registrant);
        reg.register(project, block.chainid, report, 1, expiry, 13, 0, signature);
        if (usdc.balanceOf(treasury) != 0) revert EqU(usdc.balanceOf(treasury), 0);
        if (!reg.hasBadge(project)) revert EqU(1, 0);
    }

    function test_rejectsEmptyReportAndBadGates() public {
        uint64 expiry = uint64(NOW + 1 days);
        bytes32 report = keccak256("bad");
        _fund(registrant, FEE);
        bytes memory ignored = _sign(project, report, ALL_GATES, expiry, 14);

        vm.expectRevert(GoLiveRegistry.EmptyReport.selector);
        reg.register(project, block.chainid, bytes32(0), ALL_GATES, expiry, 14, FEE, ignored);

        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.BadGates.selector, uint16(0)));
        reg.register(project, block.chainid, report, 0, expiry, 14, FEE, ignored);

        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.BadGates.selector, uint16(1 << 14)));
        reg.register(project, block.chainid, report, uint16(1 << 14), expiry, 14, FEE, ignored);
    }

    function test_signedFeeMustEqualStoredFee() public {
        bytes32 report = keccak256("fee-lock");
        uint64 expiry = uint64(NOW + 1 days);
        bytes memory signature = _sign(project, report, ALL_GATES, expiry, 16);
        _fund(registrant, FEE);
        uint256 raised = FEE + 1;
        reg.setFee(raised);
        vm.prank(registrant);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.FeeMismatch.selector, FEE, raised));
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 16, FEE, signature);
        if (usdc.balanceOf(treasury) != 0) revert EqU(usdc.balanceOf(treasury), 0);

        // A lower stored fee is also a mismatch. This is not a maximum the owner can undercut.
        uint256 lowered = FEE - 1;
        reg.setFee(lowered);
        vm.prank(registrant);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.FeeMismatch.selector, FEE, lowered));
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 16, FEE, signature);

        bytes32 digest = reg.hashRegistration(address(reg), block.chainid, project, block.chainid, report, ALL_GATES, expiry, 16, FEE);
        if (reg.usedDigest(digest)) revert EqU(1, 0);

        // The original signature works again when the stored fee is the signed fee.
        reg.setFee(FEE);
        vm.prank(registrant);
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 16, FEE, signature);
        if (usdc.balanceOf(treasury) != FEE) revert EqU(usdc.balanceOf(treasury), FEE);
    }

    function test_rejectsMalleableSignatureAndAcceptsShortV() public {
        uint64 expiry = uint64(NOW + 1 days);
        bytes32 report = keccak256("malleable");
        _fund(registrant, FEE);
        bytes32 digest = reg.hashRegistration(address(reg), block.chainid, project, block.chainid, report, ALL_GATES, expiry, 15, FEE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ANVIL_TEST_KEY, digest);
        uint256 curveN = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory high = abi.encodePacked(r, bytes32(curveN - uint256(s)), v == 27 ? bytes1(0x1c) : bytes1(0x1b));
        vm.expectRevert(GoLiveRegistry.BadSignature.selector);
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 15, FEE, high);

        // v of 0 or 1 is the same recovery id as 27 or 28.
        bytes memory low = abi.encodePacked(r, s, bytes1(v - 27));
        vm.prank(registrant);
        reg.register(project, block.chainid, report, ALL_GATES, expiry, 15, FEE, low);
        if (!reg.hasBadge(project)) revert EqU(1, 0);
    }

    function test_nativeValueIsRejected() public {
        (bool ok,) = address(reg).call{value: 1}("");
        if (ok) revert EqU(1, 0);
        (bool withData,) = address(reg).call{value: 1}(hex"1234");
        if (withData) revert EqU(1, 0);
    }

    function test_twoStepOwnership() public {
        address next = address(0x0A11);
        reg.transferOwnership(next);
        if (reg.owner() != address(this)) revert EqA(reg.owner(), address(this));
        vm.prank(registrant);
        vm.expectRevert(abi.encodeWithSelector(GoLiveRegistry.OwnableUnauthorized.selector, registrant));
        reg.acceptOwnership();
        vm.prank(next);
        reg.acceptOwnership();
        if (reg.owner() != next) revert EqA(reg.owner(), next);
        if (reg.pendingOwner() != address(0)) revert EqA(reg.pendingOwner(), address(0));
    }

    function test_sharedVectorMatchesDigestAndVerifier() public view {
        string memory json = vm.readFile("test/vectors/registration.json");
        address verifying = vm.parseJsonAddress(json, ".verifyingContract");
        uint256 domainChainId = vm.parseJsonUint(json, ".domainChainId");
        address vectorProject = vm.parseJsonAddress(json, ".project");
        uint256 chainId = vm.parseJsonUint(json, ".chainId");
        bytes32 reportHash = vm.parseJsonBytes32(json, ".reportHash");
        uint16 gates = uint16(vm.parseJsonUint(json, ".gates"));
        uint64 expiry = uint64(vm.parseJsonUint(json, ".expiry"));
        uint256 nonce = vm.parseJsonUint(json, ".nonce");
        uint256 vectorFee = vm.parseJsonUint(json, ".fee");
        bytes32 expected = vm.parseJsonBytes32(json, ".digest");
        bytes memory signature = vm.parseJsonBytes(json, ".signature");
        address expectedSigner = vm.parseJsonAddress(json, ".verifier");

        bytes32 digest = reg.hashRegistration(
            verifying, domainChainId, vectorProject, chainId, reportHash, gates, expiry, nonce, vectorFee
        );
        if (digest != expected) revert EqB(digest, expected);
        if (reg.recoverSigner(digest, signature) != expectedSigner) {
            revert EqA(reg.recoverSigner(digest, signature), expectedSigner);
        }
        if (keccak256("stable-build go-live registry test vector v1") != reportHash) revert EqB(reportHash, bytes32(0));
    }

    function test_mainnetConfirmPhrase() public pure {
        MainnetConfirm.check(5042002, "");
        MainnetConfirm.check(5042, "SEND REAL USDC");
    }

    function test_mainnetConfirmRejectsMissingPhraseAndOtherChains() public {
        vm.expectRevert(MainnetConfirm.MainnetConfirmationRequired.selector);
        this.checkConfirm(5042, "send real usdc");
        vm.expectRevert(abi.encodeWithSelector(MainnetConfirm.UnexpectedChain.selector, uint256(1)));
        this.checkConfirm(1, "SEND REAL USDC");
    }

    function checkConfirm(uint256 chainId, string calldata confirm) external pure {
        MainnetConfirm.check(chainId, confirm);
    }

    function _fund(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.prank(user);
        usdc.approve(address(reg), amount);
    }

    function _sign(address proj, bytes32 report, uint16 gates, uint64 expiry, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = reg.hashRegistration(address(reg), block.chainid, proj, block.chainid, report, gates, expiry, nonce, reg.fee());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ANVIL_TEST_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}
