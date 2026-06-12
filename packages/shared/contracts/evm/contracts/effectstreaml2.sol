// SPDX-License-Identifier: MIT

pragma solidity ^0.8.27;

import {EffectstreamL2Contract} from "@effectstream/evm-contracts/src/contracts/EffectstreamL2Contract.sol";

/**
 * @title effectstreaml2
 * @dev Thin wrapper around Effectstream's base L2 contract for Go Fish game
 */
contract effectstreaml2 is EffectstreamL2Contract {
    constructor(address owner, uint256 fee) EffectstreamL2Contract(owner, fee) {}
}
