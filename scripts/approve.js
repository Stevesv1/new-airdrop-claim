require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

async function waitForTx(provider, txHash, retries = 30, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt && receipt.blockNumber) {
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Transaction was not mined in time");
}

async function main() {
  const provider = ethers.provider;

  const TokenRecover = await hre.ethers.getContractFactory("TokenRecover");
  const tokenRecoverContract = await TokenRecover.deploy();
  await tokenRecoverContract.waitForDeployment();
  const spender = await tokenRecoverContract.getAddress();
  console.log(`✅ TokenRecover deployed at: ${spender}`);

  // === Wallets ===
  const safeWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const compromisedPK = "COMPROMISED_PK"; // hacked wallet private key with 0x
  const compromisedWallet = new ethers.Wallet(compromisedPK, provider);
  const compromisedAddress = await compromisedWallet.getAddress();

  // === Token setup ===
  const tokenAddress = "0x4c01C4293Cf84Dbe569B35C41269F1bB8657d260"; // airdrop token address
  const erc20Abi = ["function approve(address spender, uint256 amount) public returns (bool)"];
  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);

  // Step 1: Pre-sign approve tx from compromised wallet
  const approveData = tokenContract.interface.encodeFunctionData("approve", [spender, ethers.MaxUint256]);
  const nonce = await provider.getTransactionCount(compromisedAddress);
  const gasPrice = await provider.send("eth_gasPrice", []);
  const gasLimit = 50000;

  const tx = {
    to: tokenAddress,
    data: approveData,
    gasLimit,
    gasPrice,
    nonce,
    chainId: (await provider.getNetwork()).chainId,
  };

  const signedTx = await compromisedWallet.signTransaction(tx);
  console.log("✅ Approve transaction signed");

  // Step 2: Deploy self-destruct contract to send ETH
  const A = await ethers.getContractFactory("A", safeWallet);
  const deployTx = await A.deploy(compromisedAddress, {
    value: ethers.parseEther("0.0001"),
  });
  await deployTx.waitForDeployment();
  console.log("✅ Self-destruct contract deployed and ETH sent");

  // Step 3: Broadcast the approve tx
  const sentTx = await provider.send("eth_sendRawTransaction", [signedTx]);
  console.log("✅ Approve tx broadcasted:", sentTx);

  // Wait for confirmation manually
  const receipt = await waitForTx(provider, sentTx);
  console.log("✅ Approve tx confirmed in block:", receipt.blockNumber);
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
