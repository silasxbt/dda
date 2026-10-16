// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
// Isolated testnet asset. No owner, fees, blacklist, proxy, or post-deploy minting.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(string memory n, string memory s, uint8 d) {
        name=n; symbol=s; decimals=d; totalSupply=1_000_000*10**d;
        balanceOf[msg.sender]=totalSupply; emit Transfer(address(0),msg.sender,totalSupply);
    }
    function approve(address spender,uint256 amount) external returns(bool){allowance[msg.sender][spender]=amount;emit Approval(msg.sender,spender,amount);return true;}
    function transfer(address to,uint256 amount) external returns(bool){_transfer(msg.sender,to,amount);return true;}
    function transferFrom(address from,address to,uint256 amount) external returns(bool){uint256 a=allowance[from][msg.sender];require(a>=amount,"allowance");allowance[from][msg.sender]=a-amount;_transfer(from,to,amount);return true;}
    function _transfer(address from,address to,uint256 amount) private {require(to!=address(0)&&balanceOf[from]>=amount,"balance");balanceOf[from]-=amount;balanceOf[to]+=amount;emit Transfer(from,to,amount);}
}
