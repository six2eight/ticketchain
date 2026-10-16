// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TicketChain} from "../TicketChain.sol";

/// @dev Test helper: an organizer contract that tries to re-enter `withdraw` when paid.
contract ReentrantWithdrawer {
    TicketChain public immutable target;
    uint256 public reentryAttempts;

    constructor(TicketChain target_) {
        target = target_;
    }

    function createEvent(uint128 price, uint64 startTime) external returns (uint256) {
        return target.createEvent("Attack", price, 10, startTime, 0);
    }

    function attack() external {
        target.withdraw();
    }

    receive() external payable {
        reentryAttempts += 1;
        target.withdraw();
    }
}
