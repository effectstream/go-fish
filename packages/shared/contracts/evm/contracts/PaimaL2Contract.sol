// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {PaimaL2Contract as BasePaimaL2Contract} from "@paimaexample/evm-contracts/src/contracts/PaimaL2Contract.sol";

/**
 * @title PaimaL2Contract
 * @dev Thin wrapper around Paima's base L2 contract for Go Fish game
 *
 * This contract serves as the entry point for all game inputs submitted to the L2.
 * Players submit concise game commands (create lobby, join, ask for card, etc.)
 * which are then processed by the Paima Engine state machine.
 */
contract PaimaL2Contract is BasePaimaL2Contract {
    /**
     * @dev Constructor
     * @param _owner Address that will own this contract (can update fees)
     * @param _fee Fee in wei required to submit game inputs (can be 0 for free-to-play)
     */
    constructor(address _owner, uint256 _fee) BasePaimaL2Contract(_owner, _fee) {}

    // All functionality inherited from BasePaimaL2Contract:
    // - paimaSubmitGameInput(bytes data): Main function for submitting game inputs
    // - setFee(uint256 newFee): Update submission fee (owner only)
    // - Events: SubmittedGameInput(address indexed from, bytes data)
}
