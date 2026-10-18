// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title GoLiveRegistry
/// @notice Verifiable badge for a project that passed stable-build's 14 go-live gates.
/// @dev A verifier signs EIP-712 data off chain. `register` checks that signature, requires
///      the project address to have code, and pulls a fee through the USDC ERC-20 interface
///      at 0x3600…0000 (6 decimals) with `transferFrom`. Native value is refused: this
///      contract has no payable entry point that keeps `msg.value`. Arc's native USDC view
///      is 18 decimals and is a different unit for the same balance, so it is never used here.
///      https://docs.arc.io/arc/references/contract-addresses
///      https://docs.arc.io/arc/references/evm-differences
contract GoLiveRegistry {
    /// @notice USDC ERC-20 interface. Same address on Arc testnet and Arc mainnet. 6 decimals.
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    /// @notice Largest fee an owner may set: 10 USDC, in 6-decimal base units.
    uint256 public constant MAX_FEE = 10_000_000;

    /// @notice Fourteen gates, bits 0..13. Bit 0 is G1.
    uint16 public constant GATE_MASK = 0x3FFF;

    string public constant NAME = "GoLiveRegistry";
    string public constant VERSION = "1";

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant REGISTRATION_TYPEHASH = keccak256(
        "Registration(address project,uint256 chainId,bytes32 reportHash,uint16 gates,uint64 expiry,uint256 nonce)"
    );
    bytes32 public constant NAME_HASH = keccak256(bytes(NAME));
    bytes32 public constant VERSION_HASH = keccak256(bytes(VERSION));

    /// @dev secp256k1n / 2. A larger `s` is the malleable twin of `n - s`.
    uint256 private constant SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    struct Badge {
        address project;
        uint256 chainId;
        bytes32 reportHash;
        uint16 gates;
        uint64 expiry;
        uint64 registeredAt;
        address registrant;
        uint256 nonce;
    }

    address public owner;
    address public pendingOwner;
    address public verifier;
    address public treasury;
    /// @notice Fee in 6-decimal USDC base units. Zero waives the fee.
    uint256 public fee;

    mapping(bytes32 digest => bool used) public usedDigest;
    mapping(uint256 nonce => bool used) public usedNonce;
    mapping(address project => Badge badge) private _badges;
    mapping(address project => uint256 indexPlusOne) private _indexPlusOne;
    address[] private _projects;

    error OwnableUnauthorized(address account);
    error OwnableInvalidOwner(address owner);
    error ZeroAddress();
    error FeeTooHigh(uint256 fee);
    error BadGates(uint16 gates);
    error Expired(uint64 expiry, uint256 nowTs);
    error WrongChain(uint256 chainId, uint256 expected);
    error NoCode(address project);
    error EmptyReport();
    error BadSignature();
    error Replay(bytes32 digest);
    error NonceUsed(uint256 nonce);
    error NotVerifier(address signer);
    error FeeTransferFailed();
    error NativeValueRejected();

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifierSet(address indexed previousVerifier, address indexed verifier);
    event FeeSet(uint256 previousFee, uint256 fee);
    event TreasurySet(address indexed previousTreasury, address indexed treasury);
    event Registered(
        address indexed project,
        address indexed registrant,
        bytes32 indexed reportHash,
        uint16 gates,
        uint64 expiry,
        uint256 nonce,
        uint256 fee
    );

    constructor(address initialOwner, address initialVerifier, address initialTreasury, uint256 initialFee) {
        if (initialOwner == address(0) || initialVerifier == address(0) || initialTreasury == address(0)) {
            revert ZeroAddress();
        }
        if (initialFee > MAX_FEE) revert FeeTooHigh(initialFee);
        owner = initialOwner;
        verifier = initialVerifier;
        treasury = initialTreasury;
        fee = initialFee;
        emit OwnershipTransferred(address(0), initialOwner);
        emit VerifierSet(address(0), initialVerifier);
        emit TreasurySet(address(0), initialTreasury);
        emit FeeSet(0, initialFee);
    }

    /// @dev A native transfer hits this and reverts. Arc also documents that a value
    ///      transfer to a contract can revert. There is no path that credits `msg.value`.
    receive() external payable {
        revert NativeValueRejected();
    }

    fallback() external payable {
        revert NativeValueRejected();
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OwnableUnauthorized(msg.sender);
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert OwnableInvalidOwner(newOwner);
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OwnableUnauthorized(msg.sender);
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    function setVerifier(address newVerifier) external onlyOwner {
        if (newVerifier == address(0)) revert ZeroAddress();
        emit VerifierSet(verifier, newVerifier);
        verifier = newVerifier;
    }

    function setFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_FEE) revert FeeTooHigh(newFee);
        emit FeeSet(fee, newFee);
        fee = newFee;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Record a badge for `project`. The caller pays `fee` USDC (6 decimals) to `treasury`.
    /// @param chainId Must equal `block.chainid`. It is also part of the signed struct.
    /// @param reportHash `keccak256` of the exact bytes of `docs/go-live-report.md` (or of the
    ///        evidence JSON, if that is what the signer hashed).
    /// @param gates Bits 0..13. Bit 0 is G1. At least one bit must be set. No higher bit may be set.
    /// @param expiry Unix time. The signature is rejected when `block.timestamp` is greater.
    /// @param nonce Single-use. A later report for the same project needs a new nonce and signature.
    /// @param signature 65 bytes, `r || s || v`, low `s`, `v` in {27, 28} (0 and 1 are accepted).
    function register(
        address project,
        uint256 chainId,
        bytes32 reportHash,
        uint16 gates,
        uint64 expiry,
        uint256 nonce,
        bytes calldata signature
    ) external returns (bytes32 digest) {
        if (chainId != block.chainid) revert WrongChain(chainId, block.chainid);
        if (reportHash == bytes32(0)) revert EmptyReport();
        if (gates == 0 || gates > GATE_MASK) revert BadGates(gates);
        if (block.timestamp > expiry) revert Expired(expiry, block.timestamp);
        if (project.code.length == 0) revert NoCode(project);

        digest = hashRegistration(address(this), block.chainid, project, chainId, reportHash, gates, expiry, nonce);
        if (usedDigest[digest]) revert Replay(digest);
        if (usedNonce[nonce]) revert NonceUsed(nonce);

        address signer = recoverSigner(digest, signature);
        if (signer != verifier) revert NotVerifier(signer);

        // Effects before the token call. A token that called back could not reuse this digest or nonce.
        usedDigest[digest] = true;
        usedNonce[nonce] = true;
        _badges[project] = Badge({
            project: project,
            chainId: chainId,
            reportHash: reportHash,
            gates: gates,
            expiry: expiry,
            registeredAt: uint64(block.timestamp),
            registrant: msg.sender,
            nonce: nonce
        });
        if (_indexPlusOne[project] == 0) {
            _projects.push(project);
            _indexPlusOne[project] = _projects.length;
        }

        uint256 price = fee;
        if (price != 0) _pullFee(msg.sender, price);

        emit Registered(project, msg.sender, reportHash, gates, expiry, nonce, price);
    }

    function badgeOf(address project) external view returns (Badge memory) {
        return _badges[project];
    }

    function hasBadge(address project) external view returns (bool) {
        return _indexPlusOne[project] != 0;
    }

    function projectCount() external view returns (uint256) {
        return _projects.length;
    }

    function projectAt(uint256 index) external view returns (address) {
        return _projects[index];
    }

    /// @notice Badges in listing order. `limit` is capped at 50.
    function list(uint256 offset, uint256 limit) external view returns (Badge[] memory out) {
        uint256 n = _projects.length;
        if (offset > n) offset = n;
        if (limit > 50) limit = 50;
        uint256 end = offset + limit;
        if (end > n) end = n;
        out = new Badge[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            out[i - offset] = _badges[_projects[i]];
        }
    }

    /// @notice EIP-712 digest for this typed registration. `domainChainId` is the chain the
    ///         signature is bound to (the registry's `block.chainid` when verifying).
    function hashRegistration(
        address verifyingContract,
        uint256 domainChainId,
        address project,
        uint256 chainId,
        bytes32 reportHash,
        uint16 gates,
        uint64 expiry,
        uint256 nonce
    ) public pure returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, domainChainId, verifyingContract)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                REGISTRATION_TYPEHASH,
                project,
                chainId,
                reportHash,
                uint256(gates),
                uint256(expiry),
                nonce
            )
        );
        return keccak256(abi.encodePacked(bytes2(0x1901), domainSeparator, structHash));
    }

    /// @notice Address that signed `digest`, or reverts. Rejects malleable `s` and a bad `v`.
    function recoverSigner(bytes32 digest, bytes calldata signature) public pure returns (address) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := shr(248, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) == 0 || uint256(s) > SECP256K1N_HALF) revert BadSignature();
        if (uint256(r) == 0) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    /// @dev Pull `amount` of 6-decimal USDC. The token's own revert (allowance, balance,
    ///      blocklist) is rethrown. A `false` return without a revert is `FeeTransferFailed`.
    function _pullFee(address from, uint256 amount) private {
        (bool ok, bytes memory data) =
            USDC.call(abi.encodeWithSelector(IUsdc.transferFrom.selector, from, treasury, amount));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(data, 0x20), mload(data))
            }
        }
        if (data.length < 32 || !abi.decode(data, (bool))) revert FeeTransferFailed();
    }
}

interface IUsdc {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice Placeholder project for the owner's demo. The registry only checks that it has code.
contract DemoProject {}
