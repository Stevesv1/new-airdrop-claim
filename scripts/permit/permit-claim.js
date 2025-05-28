require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const readline = require("readline");

const permitAndTransferIface = new ethers.Interface([
  "function permitAndTransfer(address token,address owner,address to,uint256 amount,uint256 deadline,uint8 v,bytes32 r,bytes32 s)"
]);

async function askConfirmation(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  const provider = ethers.provider;
  const safeWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const compromisedWallet = new ethers.Wallet(process.env.COMPROMISED_KEY, provider);

  const compromisedAddress = await compromisedWallet.getAddress();
  const feeData = await provider.getFeeData();
  const network = await provider.getNetwork();
  const latestBlock = await provider.getBlock("latest");

  const baseNonce = await provider.getTransactionCount(compromisedAddress, latestBlock.number);
  const chainId = network.chainId;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const tokenAddress = process.env.TOKEN_ADDRESS;
  const safeAddress = process.env.SAFE_ADDRESS;
  const airdropContract = process.env.AIRDROP_CONTRACT;
  const permitAndTransfer = process.env.PERMIT_TRANSFER_CONTRACT;
  const tokenName = process.env.TOKEN_NAME;

  const tokenContract = await ethers.getContractAt("ERC20", tokenAddress);
  const decimals = await tokenContract.decimals();
  const balance = ethers.parseUnits("1", decimals);

  // Fetch token nonce via eth_call
  const tokenNonceData = await provider.send("eth_call", [{
    to: tokenAddress,
    data: "0x7ecebe00" + compromisedAddress.slice(2).padStart(64, "0")
  }, `0x${latestBlock.number.toString(16)}`]);
  let tokenNonce = ethers.toBigInt(tokenNonceData);

  const domain = {
    name: tokenName,
    version: "1",
    chainId,
    verifyingContract: tokenAddress,
  };

  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const maxFeePerGas = feeData.maxFeePerGas + ethers.parseUnits("3", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas + ethers.parseUnits("3", "gwei");

  const totalRounds = 5; // total 5 rounds of claim + permit tx pairs = 10 txs

  console.log(`💸 Gas price (maxFeePerGas): ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`);

  const confirm = await askConfirmation(`Proceed with deploying contract and sending claim+permit txs ${totalRounds} times? Type 'yes' to continue: `);
  if (!confirm) {
    console.log("❌ Operation cancelled.");
    return;
  }

  // Pre-sign all 10 transactions upfront
  const signedTxs = [];
  let nonceOffset = 0;
  let currentTokenNonce = tokenNonce;

  for (let i = 0; i < totalRounds; i++) {
    // Claim tx
    const claimTx = {
      to: airdropContract,
      data: "0x4e71d92d",
      gasLimit: 150000n,
      nonce: baseNonce + nonceOffset,
      chainId,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };

    // Permit message and signature
    const message = {
      owner: compromisedAddress,
      spender: permitAndTransfer,
      value: balance,
      nonce: currentTokenNonce,
      deadline,
    };
    const sig = await compromisedWallet.signTypedData(domain, types, message);
    const { v, r, s } = ethers.Signature.from(sig);

    const permitData = permitAndTransferIface.encodeFunctionData("permitAndTransfer", [
      tokenAddress,
      compromisedAddress,
      safeAddress,
      balance,
      deadline,
      v,
      r,
      s,
    ]);

    // Permit tx
    const permitTx = {
      to: permitAndTransfer,
      data: permitData,
      gasLimit: 200000n,
      nonce: baseNonce + nonceOffset + 1n,
      chainId,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };

    // Sign both txs
    const [signedClaim, signedPermit] = await Promise.all([
      compromisedWallet.signTransaction(claimTx),
      compromisedWallet.signTransaction(permitTx),
    ]);

    signedTxs.push(signedClaim, signedPermit);

    nonceOffset += 2n;
    currentTokenNonce++;
  }

  const sentTxHashes = [];
  let deployTxHash = null;

  // Helper function to send a pair of signed txs (claim + permit)
  async function sendTxPair(roundIndex) {
    const claimTxSigned = signedTxs[roundIndex * 2];
    const permitTxSigned = signedTxs[roundIndex * 2 + 1];

    const results = await Promise.allSettled([
      provider.send("eth_sendRawTransaction", [claimTxSigned]),
      provider.send("eth_sendRawTransaction", [permitTxSigned]),
    ]);

    for (const res of results) {
      if (res.status === "fulfilled" && typeof res.value === "string") {
        sentTxHashes.push(res.value);
        console.log(`✅ Sent tx hash: ${res.value}`);
      } else if (res.status === "rejected") {
        console.error("❌ Transaction send failed:", res.reason);
      }
    }
  }

  // Send first 2 rounds (round 0 and 1)
  console.log("🚀 Sending first 2 rounds (4 transactions)...");
  await sendTxPair(0);
  await sendTxPair(1);

  // Start contract deployment async (fire & forget)
  (async () => {
    try {
      const ContractFactory = await ethers.getContractFactory("A", safeWallet);
      const contract = await ContractFactory.deploy(compromisedAddress, {
        value: ethers.parseEther("0.002"),
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      deployTxHash = contract.deploymentTransaction().hash;
      console.log(`✅ Contract deployment tx hash (sent): ${deployTxHash}`);
    } catch (err) {
      console.error("❌ Contract deployment failed:", err.message);
    }
  })();

  // Send 1 round (round 2) in parallel with contract deployment
  console.log("🚀 Sending 3rd round (2 transactions) in parallel with contract deployment...");
  await sendTxPair(2);

  // Send last 2 rounds (round 3 and 4)
  console.log("🚀 Sending last 2 rounds (4 transactions)...");
  await sendTxPair(3);
  await sendTxPair(4);

  // Add deploy tx hash if any
  if (deployTxHash) {
    sentTxHashes.push(deployTxHash);
  }

  if (sentTxHashes.length > 0) {
    console.log("\n📬 Successfully sent transactions:");
    for (const hash of sentTxHashes) {
      console.log(` - ${hash}`);
    }
  } else {
    console.log("⚠️  No successful transactions detected.");
  }
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
