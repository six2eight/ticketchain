// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title TicketChain — NFT event tickets with capped resale and on-chain check-in.
/// @notice Tickets are non-transferable except through `buyResale`, which enforces the
///         organizer's resale price cap. Check-in marks a ticket as used forever.
contract TicketChain is ERC721, AccessControl, ReentrancyGuard, EIP712 {
    struct EventInfo {
        address organizer;
        uint128 price; // wei per ticket
        uint128 resaleCap; // max resale price in wei (0 = resale disabled)
        uint32 maxSupply;
        uint32 sold;
        uint64 startTime; // unix seconds; sales and resale close at start
        bool exists;
    }

    struct Listing {
        address seller;
        uint128 price;
    }

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    uint256 public nextEventId = 1;
    uint256 public nextTokenId = 1;
    mapping(uint256 => EventInfo) public events;
    mapping(uint256 => uint256) public ticketEvent; // tokenId => eventId
    mapping(uint256 => bool) public used; // tokenId => checked in
    mapping(uint256 => mapping(address => bool)) public isStaff; // eventId => wallet => bool
    mapping(uint256 => Listing) public listings; // tokenId => listing
    mapping(address => uint256) public pendingWithdrawals; // pull payments
    string private _baseTokenURI;

    /// @dev Set only while `buyResale` moves a token; every other transfer is rejected.
    bool private _resaleInProgress;

    event EventCreated(
        uint256 indexed eventId,
        address indexed organizer,
        string name,
        uint128 price,
        uint32 maxSupply,
        uint64 startTime,
        uint128 resaleCap
    );
    event StaffUpdated(uint256 indexed eventId, address indexed wallet, bool allowed);
    event TicketPurchased(
        uint256 indexed tokenId,
        uint256 indexed eventId,
        address indexed buyer,
        uint128 price
    );
    event TicketListed(uint256 indexed tokenId, address indexed seller, uint128 price);
    event ListingCancelled(uint256 indexed tokenId);
    event TicketResold(
        uint256 indexed tokenId,
        address indexed from,
        address indexed to,
        uint128 price
    );
    event TicketCheckedIn(uint256 indexed tokenId, uint256 indexed eventId, address operator);
    event Withdrawal(address indexed account, uint256 amount);

    error EventNotFound();
    error NotOrganizer();
    error InvalidParams();
    error WrongPayment();
    error SoldOut();
    error SalesClosed();
    error NotOwner();
    error ResaleDisabled();
    error PriceAboveCap();
    error NotListed();
    error TicketUsed();
    error NotAuthorized();
    error TransfersDisabled();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(string memory baseURI_) ERC721("TicketChain", "TCKT") EIP712("TicketChain", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _baseTokenURI = baseURI_;
    }

    // ---------------------------------------------------------------- events

    function createEvent(
        string calldata name,
        uint128 price,
        uint32 maxSupply,
        uint64 startTime,
        uint128 resaleCap
    ) external returns (uint256 eventId) {
        if (maxSupply == 0 || startTime <= block.timestamp) revert InvalidParams();
        if (resaleCap != 0 && resaleCap < price) revert InvalidParams();

        eventId = nextEventId++;
        events[eventId] = EventInfo({
            organizer: msg.sender,
            price: price,
            resaleCap: resaleCap,
            maxSupply: maxSupply,
            sold: 0,
            startTime: startTime,
            exists: true
        });

        emit EventCreated(eventId, msg.sender, name, price, maxSupply, startTime, resaleCap);
    }

    function addStaff(uint256 eventId, address wallet) external {
        _setStaff(eventId, wallet, true);
    }

    function removeStaff(uint256 eventId, address wallet) external {
        _setStaff(eventId, wallet, false);
    }

    function _setStaff(uint256 eventId, address wallet, bool allowed) private {
        EventInfo storage ev = _existingEvent(eventId);
        if (msg.sender != ev.organizer) revert NotOrganizer();
        isStaff[eventId][wallet] = allowed;
        emit StaffUpdated(eventId, wallet, allowed);
    }

    // --------------------------------------------------------------- primary

    function buyTicket(uint256 eventId) external payable returns (uint256 tokenId) {
        EventInfo storage ev = _existingEvent(eventId);
        if (block.timestamp >= ev.startTime) revert SalesClosed();
        if (ev.sold >= ev.maxSupply) revert SoldOut();
        if (msg.value != ev.price) revert WrongPayment();

        ev.sold += 1;
        tokenId = nextTokenId++;
        ticketEvent[tokenId] = eventId;
        pendingWithdrawals[ev.organizer] += msg.value;

        _mint(msg.sender, tokenId);
        emit TicketPurchased(tokenId, eventId, msg.sender, ev.price);
    }

    // ---------------------------------------------------------------- resale

    function listForResale(uint256 tokenId, uint128 price) external {
        if (ownerOf(tokenId) != msg.sender) revert NotOwner();
        EventInfo storage ev = events[ticketEvent[tokenId]];
        if (ev.resaleCap == 0) revert ResaleDisabled();
        if (used[tokenId]) revert TicketUsed();
        if (block.timestamp >= ev.startTime) revert SalesClosed();
        if (price > ev.resaleCap) revert PriceAboveCap();

        listings[tokenId] = Listing({seller: msg.sender, price: price});
        emit TicketListed(tokenId, msg.sender, price);
    }

    function cancelListing(uint256 tokenId) external {
        Listing storage listing = listings[tokenId];
        if (listing.seller == address(0)) revert NotListed();
        if (listing.seller != msg.sender) revert NotOwner();

        delete listings[tokenId];
        emit ListingCancelled(tokenId);
    }

    function buyResale(uint256 tokenId) external payable nonReentrant {
        Listing memory listing = listings[tokenId];
        if (listing.seller == address(0)) revert NotListed();
        if (listing.seller == msg.sender) revert InvalidParams();
        if (used[tokenId]) revert TicketUsed();
        if (block.timestamp >= events[ticketEvent[tokenId]].startTime) revert SalesClosed();
        if (msg.value != listing.price) revert WrongPayment();

        delete listings[tokenId];
        pendingWithdrawals[listing.seller] += msg.value;

        _resaleInProgress = true;
        _transfer(listing.seller, msg.sender, tokenId);
        _resaleInProgress = false;

        emit TicketResold(tokenId, listing.seller, msg.sender, listing.price);
    }

    // -------------------------------------------------------------- check-in

    function checkIn(uint256 tokenId) external {
        _requireOwned(tokenId);
        uint256 eventId = ticketEvent[tokenId];
        if (
            msg.sender != events[eventId].organizer &&
            !isStaff[eventId][msg.sender] &&
            !hasRole(RELAYER_ROLE, msg.sender)
        ) revert NotAuthorized();
        if (used[tokenId]) revert TicketUsed();

        used[tokenId] = true;
        delete listings[tokenId];
        emit TicketCheckedIn(tokenId, eventId, msg.sender);
    }

    // -------------------------------------------------------------- payments

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawal(msg.sender, amount);
    }

    // -------------------------------------------------------------- metadata

    function setBaseURI(string calldata baseURI_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _baseTokenURI = baseURI_;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // ------------------------------------------------------------- internals

    function _existingEvent(uint256 eventId) private view returns (EventInfo storage ev) {
        ev = events[eventId];
        if (!ev.exists) revert EventNotFound();
    }

    /// @dev Only mints and transfers performed inside `buyResale` are allowed (anti-scalping).
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0) && !_resaleInProgress) revert TransfersDisabled();
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
