require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

async function sendTx(provider, signedTx, txName) {
  try {
    const result = await provider.send("eth_sendRawTransaction", [signedTx]);
    console.log(`✅ ${txName} transaction sent: ${result}`);
    return result;
  } catch (err) {
    console.log(`❌ ${txName} transaction failed: ${err.message}`);
    return null;
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
  const hardcodedTokenAmount = process.env.TOKEN_AMOUNT;
  const compromisedBalance = await provider.getBalance(compromisedAddress);
  const safeBalance = await provider.getBalance(safeAddress);
  const feeData = await provider.getFeeData();

  console.log(`💰 Compromised wallet ETH: ${ethers.formatEther(compromisedBalance)} ETH`);
  console.log(`💰 Safe wallet ETH: ${ethers.formatEther(safeBalance)} ETH`);

  // == Use Correct Gas Limit Here ==
  const CLAIM_GAS_LIMIT = BigInt(100000); // Use correct gas limit for claim
  const RECOVER_GAS_LIMIT = BigInt(100000);
  const FUNDING_GAS_LIMIT = BigInt(200000); 

  // == Use High Gas Fee ==
  const GAS_MAX_FEE_PER_GAS = feeData.maxFeePerGas + ethers.parseUnits("3", "gwei"); // This gas price must be more than or equal to the below one (priority fee)
  const GAS_MAX_PRIORITY_FEE = feeData.maxPriorityFeePerGas + ethers.parseUnits("2", "gwei");

  const claimGasCost = CLAIM_GAS_LIMIT * GAS_MAX_FEE_PER_GAS;
  const recoverGasCost = RECOVER_GAS_LIMIT * GAS_MAX_FEE_PER_GAS;
  const fundingAmount = claimGasCost + ethers.parseEther("0.0002"); // Gas fee amount u want to send to your compromised wallet
  const totalSafeWalletCost = fundingAmount + recoverGasCost;

  console.log(`\n⛽️ Gas Fee Configuration:`);
  console.log(`   All Transactions - Max Fee: ${ethers.formatUnits(GAS_MAX_FEE_PER_GAS, "gwei")} Gwei, Priority: ${ethers.formatUnits(GAS_MAX_PRIORITY_FEE, "gwei")} Gwei`);
  console.log(`💸 Total gas fee needed for CLAIM: ${ethers.formatEther(claimGasCost)} ETH`);
  console.log(`💸 Total gas fee needed for RECOVER: ${ethers.formatEther(recoverGasCost)} ETH`);
  console.log(`💸 Funding amount (with buffer): ${ethers.formatEther(fundingAmount)} ETH`);
  console.log(`💸 Total safe wallet cost (funding + recover): ${ethers.formatEther(totalSafeWalletCost)} ETH`);

  if (safeBalance < totalSafeWalletCost) {
    console.error(`❌ Insufficient balance in safe wallet: ${ethers.formatEther(safeBalance)} ETH available, need ${ethers.formatEther(totalSafeWalletCost)} ETH`);
    process.exit(1);
  }
  const chainId = (await provider.getNetwork()).chainId;
  const compromisedNonce = await provider.getTransactionCount(compromisedAddress, "pending");
  let safeNonce = await provider.getTransactionCount(safeAddress, "pending");

  console.log(`📊 Initial nonces - Compromised: ${compromisedNonce}, Safe: ${safeNonce}`);
  console.log("\n🛠️ Pre-signing all transactions...");
  const Funder = await ethers.getContractFactory("A", safeWallet);
  const fundingTxData = await Funder.getDeployTransaction(compromisedAddress, {
    value: fundingAmount,
  });
  const fundingTx = {
    to: null,
    data: fundingTxData.data,
    value: fundingAmount,
    gasLimit: FUNDING_GAS_LIMIT,
    maxFeePerGas: GAS_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: GAS_MAX_PRIORITY_FEE,
    nonce: safeNonce,
    chainId,
    type: 2,
  };
  const signedFundingTx = await safeWallet.signTransaction(fundingTx);

  const claimTx = {
    to: airdropContractAddress,
    data: "0x4e71d92d", // Claim HEX data, this should be different for every airdrops
    gasLimit: CLAIM_GAS_LIMIT,
    maxFeePerGas: GAS_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: GAS_MAX_PRIORITY_FEE,
    nonce: compromisedNonce,
    chainId,
    type: 2,
  };
  const signedClaimTx = await compromisedWallet.signTransaction(claimTx);
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

  const signedRecoverTxs = [];
  for (let i = 1; i <= 2; i++) {
    const recoverTx = {
      to: recoverContractAddress,
      data: recoverData,
      gasLimit: RECOVER_GAS_LIMIT,
      maxFeePerGas: GAS_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: GAS_MAX_PRIORITY_FEE,
      nonce: safeNonce + i,
      chainId,
      type: 2,
    };
    const signedRecoverTx = await safeWallet.signTransaction(recoverTx);
    signedRecoverTxs.push({ nonce: safeNonce + i, signedTx: signedRecoverTx });
  }

  console.log("✅ All transactions pre-signed!");
  console.log(`🪙 Token amount to recover: ${ethers.formatUnits(tokenAmountToRecover, decimals)} tokens`);


  console.log("\n🚀 Starting relentless transaction sending (funding → claim → recover)...");
  let fundingSent = false;
  let claimSent = false;
  let recoverSent = false;
  let recoverAttemptIndex = 0;

  while (!fundingSent || !claimSent || !recoverSent) {
    // Step 1: Send funding transaction until accepted
    if (!fundingSent) {
      const fundingResult = await sendTx(provider, signedFundingTx, "Funding");
      if (fundingResult) fundingSent = true;
    }

    // Step 2: Send claim transaction only after funding is sent
    if (fundingSent && !claimSent) {
      const claimResult = await sendTx(provider, signedClaimTx, "Claim");
      if (claimResult) claimSent = true;
    }

    // Step 3: Send recover transaction only after claim is sent
    if (claimSent && !recoverSent && recoverAttemptIndex < signedRecoverTxs.length) {
      const recoverTx = signedRecoverTxs[recoverAttemptIndex];
      const recoverResult = await sendTx(provider, recoverTx.signedTx, `Recover (nonce ${recoverTx.nonce})`);
      if (recoverResult) {
        recoverSent = true;
      } else {
        recoverAttemptIndex++;
      }
    }
  }

  console.log("\n🎉 Success! All transactions were sent successfully:");
  if (fundingSent) console.log("   ✅ Funding transaction succeeded.");
  if (claimSent) console.log("   ✅ Claim transaction succeeded.");
  if (recoverSent) console.log(`   ✅ Recover transaction succeeded (nonce ${signedRecoverTxs[recoverAttemptIndex].nonce}).`);
  console.log("📝 Check transaction status on a blockchain explorer.");
}

main().catch((err) => {
  console.error("❌ Script failed:", err.message);
  console.error("Stack trace:", err.stack);
  process.exit(1);
});
