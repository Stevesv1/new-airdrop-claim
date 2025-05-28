// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract TokenRecover {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    /**
     * @notice Pull tokens from a compromised wallet (already approved this contract)
     * @param token Address of the ERC20 token contract
     * @param from Compromised wallet address
     * @param to Destination address (you)
     * @param amount How many tokens to pull
     */
    function recover(address token, address from, address to, uint256 amount) external onlyOwner {
        require(token != address(0) && from != address(0) && to != address(0), "Zero address");
        bool success = IERC20(token).transferFrom(from, to, amount);
        require(success, "Transfer failed");
    }

    // Optional: allow contract self-destruct once done
    function destroy() external onlyOwner {
        selfdestruct(payable(owner));
    }
}
