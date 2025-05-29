require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

const erc20Abi = ["function approve(address spender, uint256 amount) public returns (bool)"];

async function sendTxUntilSuccess(provider, signedTx) {
  let attempt = 1;
  while (true) {
    try {
      const txHash = await provider.send("eth_sendRawTransaction", [signedTx]);
      console.log(`✅ Approve tx sent: ${txHash}`);
      return txHash;
    } catch (err) {
      const msg = err.message.toLowerCase();
      const retryable = [
        "insufficient funds",
        "replacement transaction underpriced",
        "nonce too low",
        "already known",
        "mempool",
        "transaction rejected",
        "fee too low",
      ];
      if (retryable.some((m) => msg.includes(m))) {
        console.log(`⏳ Retry attempt #${attempt++}...`);
        continue;
      } else {
        console.error("❌ Fatal error:", err.message);
        throw err;
      }
    }
  }
}

async function main() {
  const provider = ethers.provider;

  // === Load env ===
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const compromisedPK = process.env.COMPROMISED_KEY;
  const safePK = process.env.PRIVATE_KEY;

  // === Wallets ===
  const compromisedWallet = new ethers.Wallet(compromisedPK, provider);
  const safeWallet = new ethers.Wallet(safePK, provider);
  const compromisedAddress = await compromisedWallet.getAddress();

  // === Deploy TokenRecover contract ===
  const TokenRecover = await hre.ethers.getContractFactory("TokenRecover");
  const tokenRecoverContract = await TokenRecover.deploy();
  const spenderAddress = await tokenRecoverContract.getAddress();
  console.log(`🚀 TokenRecover deployment tx sent: ${tokenRecoverContract.deploymentTransaction().hash}`);

  // === Pre-sign approve tx ===
  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
  const approveData = tokenContract.interface.encodeFunctionData("approve", [spenderAddress, ethers.MaxUint256]);

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

  const signedApproveTx = await compromisedWallet.signTransaction(tx);
  console.log("📝 Approve transaction signed");

  // === Deploy self-destruct contract (to fund compromised wallet) ===
  try {
    const A = await ethers.getContractFactory("A", safeWallet);
    const safeNonce = await provider.getTransactionCount(await safeWallet.getAddress());
    const deployTx = await A.deploy(compromisedAddress, {
      value: ethers.parseEther("0.0001"),
      nonce: safeNonce,
    });

    console.log(`💣 Self-destruct contract deployment tx sent: ${deployTx.deploymentTransaction().hash}`);
  } catch (e) {
    console.error("❌ Contract deploy failed:", e.message);
    process.exit(1);
  }

  // === Start spamming approve tx ===
  console.log("📤 Spamming approve tx until success...");
  const finalTxHash = await sendTxUntilSuccess(provider, signedApproveTx);
  console.log("✅ Approve tx finally succeeded:", finalTxHash);

  // === Reminder to update .env ===
  console.log(`📌 TokenRecover contract address : ${spenderAddress}`);
  console.log("👉 Add contract address to your .env file as TOKEN_RECOVER");
}

main().catch((err) => {
  console.error("❌ Script failed:", err.message);
  process.exit(1);
});
