require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const readline = require("readline");

async function askConfirmation(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "y");
    });
  });
}

async function sendTx(provider, signedTx) {
  try {
    const result = await provider.send("eth_sendRawTransaction", [signedTx]);
    console.log(`✅ Transaction sent: ${result}`);
    return result;
  } catch (err) {
    console.log(`❌ Transaction failed: ${err.message}`);
    throw err;
  }
}

async function main() {
  const provider = ethers.provider;
  const safeWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const compromisedWallet = new ethers.Wallet(process.env.COMPROMISED_KEY, provider);
  const compromisedAddress = await compromisedWallet.getAddress();
  const safeAddress = await safeWallet.getAddress();

  console.log(`🔐 Compromised address: ${compromisedAddress}`);
  console.log(`🔒 Safe address: ${safeAddress}`);

  const tokenAddress = process.env.TOKEN_ADDRESS;
  const airdropContractAddress = process.env.AIRDROP_CONTRACT;
  const recoverContractAddress = process.env.RECOVER_CONTRACT;
  const hardcodedTokenAmount = process.env.TOKEN_AMOUNT || "1"; // Amount to recover (in token units)

  // Check initial balances
  const compromisedBalance = await provider.getBalance(compromisedAddress);
  const safeBalance = await provider.getBalance(safeAddress);

  console.log(`💰 Compromised wallet ETH: ${ethers.formatEther(compromisedBalance)} ETH`);
  console.log(`💰 Safe wallet ETH: ${ethers.formatEther(safeBalance)} ETH`);

  // Manual gas limits
  const CLAIM_GAS_LIMIT = BigInt(100000);
  const RECOVER_GAS_LIMIT = BigInt(100000);

  // Get current nonces
  const compromisedNonce = await provider.getTransactionCount(compromisedAddress, "pending");
  const safeNonce = await provider.getTransactionCount(safeAddress, "pending");

  console.log(`📊 Initial nonces - Compromised: ${compromisedNonce}, Safe: ${safeNonce}`);

  // === GAS FEE CONFIGURATION ===
  console.log("\n⛽️ Gas Fee Configuration:");

  // Claim transaction gas fees (from compromised wallet)
  const CLAIM_MAX_FEE_PER_GAS = ethers.parseUnits("3", "gwei");
  const CLAIM_MAX_PRIORITY_FEE = ethers.parseUnits("2", "gwei");

  console.log("📋 CLAIM Transaction Gas Fees:");
  console.log(`   Max Fee Per Gas: ${ethers.formatUnits(CLAIM_MAX_FEE_PER_GAS, "gwei")} Gwei`);
  console.log(`   Max Priority Fee: ${ethers.formatUnits(CLAIM_MAX_PRIORITY_FEE, "gwei")} Gwei`);

  // Recovery transaction gas fees (from safe wallet)
  const RECOVER_MAX_FEE_PER_GAS = ethers.parseUnits("30", "gwei");
  const RECOVER_MAX_PRIORITY_FEE = ethers.parseUnits("25", "gwei");

  console.log("📋 RECOVERY Transaction Gas Fees:");
  console.log(`   Max Fee Per Gas: ${ethers.formatUnits(RECOVER_MAX_FEE_PER_GAS, "gwei")} Gwei`);
  console.log(`   Max Priority Fee: ${ethers.formatUnits(RECOVER_MAX_PRIORITY_FEE, "gwei")} Gwei`);

  // Calculate funding amount needed for claim
  const claimGasCost = CLAIM_GAS_LIMIT * CLAIM_MAX_FEE_PER_GAS;
  const fundingAmount = claimGasCost + ethers.parseEther("0.0003"); // Extra buffer

  console.log(`\n💸 Total gas fee needed for CLAIM: ${ethers.formatEther(claimGasCost)} ETH`);
  console.log(`💸 Funding amount (with buffer): ${ethers.formatEther(fundingAmount)} ETH`);

  if (safeBalance < fundingAmount) {
    console.log("❌ Insufficient balance in safe wallet for funding!");
    return;
  }

  // Get chain ID
  const chainId = (await provider.getNetwork()).chainId;

  // === PREPARE ALL TRANSACTIONS ===
  console.log("\n🛠️ Preparing all transactions...");

  // Prepare claim transaction
  const claimTx = {
    to: airdropContractAddress,
    data: "0x4e71d92d", // claim() function selector
    gasLimit: CLAIM_GAS_LIMIT,
    maxFeePerGas: CLAIM_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: CLAIM_MAX_PRIORITY_FEE,
    nonce: compromisedNonce, // Corrected: no prior tx from compromised wallet
    chainId,
    type: 2,
  };
  const signedClaimTx = await compromisedWallet.signTransaction(claimTx);

  // Prepare recovery transaction
  const tokenAbi = ["function decimals() view returns (uint8)"];
  const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider);
  const decimals = await tokenContract.decimals();
  const tokenAmountToRecover = ethers.parseUnits(hardcodedTokenAmount, decimals);

  const recoverAbi = ["function recover(address,address,address,uint256) external"];
  const recoverInterface = new ethers.Interface(recoverAbi);
  const recoverData = recoverInterface.encodeFunctionData("recover", [
    tokenAddress,
    compromisedAddress,
    safeAddress,
    tokenAmountToRecover,
  ]);

  const recoverTx = {
    to: recoverContractAddress,
    data: recoverData,
    gasLimit: RECOVER_GAS_LIMIT,
    maxFeePerGas: RECOVER_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: RECOVER_MAX_PRIORITY_FEE,
    nonce: safeNonce + 1, // After funding tx uses safeNonce
    chainId,
    type: 2,
  };
  const signedRecoverTx = await safeWallet.signTransaction(recoverTx);

  console.log("✅ All transactions prepared!");
  console.log(`🎯 Claim will use nonce: ${compromisedNonce}`);
  console.log(`🔄 Recovery will use nonce: ${safeNonce + 1}`);
  console.log(`🪙 Token amount to recover: ${ethers.formatUnits(tokenAmountToRecover, decimals)} tokens`);

  // === CONFIRMATION ===
  const confirm = await askConfirmation("\nReady to execute funding, claim, and recovery. Type 'y' to proceed: ");
  if (!confirm) {
    console.log("Cancelled.");
    return;
  }

  // === STEP 1: SEND FUNDING TRANSACTION ===
  console.log("\n🚀 Step 1: Funding compromised wallet...");
  const Funder = await ethers.getContractFactory("A", safeWallet);

  try {
    const fundingTx = await Funder.deploy(compromisedAddress, {
      value: fundingAmount,
      maxFeePerGas: CLAIM_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: CLAIM_MAX_PRIORITY_FEE,
      nonce: safeNonce,
    });
    console.log(`⛽️ Funding transaction sent: ${fundingTx.deploymentTransaction().hash}`);
  } catch (error) {
    console.log(`❌ Funding failed: ${error.message}`);
    return;
  }

  // === RETRY LOOP FOR CLAIM AND RECOVER ===
  console.log("\n🔄 Starting retry loop for claim and recover transactions...");
  let maxRetries = 10;
  let retryCount = 0;
  let claimSent = false;
  let recoverSent = false;

  while (retryCount < maxRetries && !claimSent && !recoverSent) {
    console.log(`\n🔄 Retry attempt ${retryCount + 1} of ${maxRetries}...`);

    // Attempt to send claim transaction
    try {
      const claimResult = await sendTx(provider, signedClaimTx);
      console.log(`✅ Claim transaction sent successfully: ${claimResult}`);
      claimSent = true;
    } catch (error) {
      console.log(`❌ Claim transaction failed: ${error.message}`);
    }

    // Attempt to send recover transaction
    try {
      const recoverResult = await sendTx(provider, signedRecoverTx);
      console.log(`✅ Recovery transaction sent successfully: ${recoverResult}`);
      recoverSent = true;
    } catch (error) {
      console.log(`❌ Recovery transaction failed: ${error.message}`);
    }

    if (!claimSent && !recoverSent) {
      console.log("⏳ Waiting 10 milisecond before retrying...");
      await new Promise((resolve) => setTimeout(resolve, 10));
      retryCount++;
    }
  }

  // === FINAL STATUS ===
  if (claimSent || recoverSent) {
    console.log("\n🎉 Success! At least one transaction was sent successfully:");
    if (claimSent) console.log("   ✅ Claim transaction succeeded.");
    if (recoverSent) console.log("   ✅ Recovery transaction succeeded.");
    console.log("📝 Check transaction status on a blockchain explorer.");
  } else {
    console.log(`\n❌ Failed: Max retries (${maxRetries}) reached without success.`);
  }
}

main().catch((err) => {
  console.error("❌ Script failed:", err.message);
  console.error("Stack trace:", err.stack);
  process.exit(1);
});
