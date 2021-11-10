// https://Smashcash.io
/*
* Smashcash
*/

pragma solidity 0.5.17;

import "./Smashnado.sol";

contract XDAISmashnado is Smashnado {
  constructor(
    IVerifier _verifier,
    uint256 _denomination,
    uint32 _merkleTreeHeight,
    address _operator
  ) Smashnado(_verifier, _denomination, _merkleTreeHeight, _operator) public {
  }
  function _processDeposit() internal {
    require(msg.value == denomination, "Please send `mixDenomination` ETH along with transaction");
  }

  function _processWithdraw(address payable _recipient, address payable _relayer, uint256 _fee, uint256 _refund) internal {
    // sanity checks
    require(msg.value == 0, "Message value is supposed to be zero for ETH instance");
    require(_refund == 0, "Refund value is supposed to be zero for ETH instance");

    // send to redipient 
    (bool success, ) = _recipient.call.value(denomination - _fee )("");      
    require(success, "payment to _recipient did not go thru");
    // send fee to relayer
    if (_fee > 0) {
      (success, ) = _relayer.call.value(_fee)("");
      require(success, "payment to _relayer did not go thru");
    }
    
  }
}
