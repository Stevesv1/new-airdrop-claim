require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const readline = require("readline");

const permitAndTransferIface = new ethers.Interface([
  "function permitAndTransfer(address token,address owner,address to,uint256 amount,uint256 deadline,uint8 v,bytes32 r,bytes32 s)"
]);

function askConfirmation(prompt) {
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
    const txHash = await provider.send("eth_sendRawTransaction", [signedTx]);
    return txHash;
  } catch (err) {
    const msg = err.message.toLowerCase();
    const retryable = [
      "insufficient funds", "replacement transaction underpriced", "nonce too low",
      "already known", "mempool", "transaction rejected", "fee too low"
    ];
    return retryable.some((m) => msg.includes(m)) ? null : Promise.reject(err);
  }
}

async function main() {
  const provider = ethers.provider;
  const safeWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const compromisedWallet = new ethers.Wallet(process.env.COMPROMISED_KEY, provider);
  const compromisedAddress = await compromisedWallet.getAddress();

  const feeData = await provider.getFeeData();
  const network = await provider.getNetwork();

  const baseNonce = await provider.getTransactionCount(compromisedAddress, "latest");
  const chainId = network.chainId;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const tokenAddress = process.env.TOKEN_ADDRESS;
  const safeAddress = process.env.SAFE_ADDRESS;
  const airdropContract = process.env.AIRDROP_CONTRACT;
  const permitAndTransfer = process.env.PERMIT_TRANSFER_CONTRACT;
  const tokenName = process.env.TOKEN_NAME;

  const tokenAbi = ["function decimals() view returns (uint8)"];
  const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider);
  const decimals = await tokenContract.decimals();
  const balance = ethers.parseUnits("1", decimals);

  const callData = "0x7ecebe00" + compromisedAddress.slice(2).padStart(64, "0");
  const tokenNonceData = await provider.send("eth_call", [{ to: tokenAddress, data: callData }, "latest"]);
  const tokenNonce = ethers.toBigInt(tokenNonceData);

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

  const maxFeePerGas = feeData.maxFeePerGas + ethers.parseUnits("5", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas + ethers.parseUnits("5", "gwei");

  const claimGas = 150000n;
  const permitGas = 200000n;
  const totalGas = claimGas + permitGas;

  console.log(`Estimated cost per batch: ~${ethers.formatEther(totalGas * maxFeePerGas)} ETH`);

  const confirm = await askConfirmation("Type 'y' to confirm and pre-sign 50 batches: ");
  if (!confirm) {
    console.log("Cancelled.");
    return;
  }

  const signedBatches = [];

  // Sign 50 batches ahead with same nonce & tokenNonce
  for (let i = 0; i < 50; i++) {
    const message = {
      owner: compromisedAddress,
      spender: permitAndTransfer,
      value: balance,
      nonce: tokenNonce,
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

    const claimTx = {
      to: airdropContract,
      data: "0x4e71d92d", // claim()
      gasLimit: claimGas,
      nonce: baseNonce,
      chainId,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };

    const permitTx = {
      to: permitAndTransfer,
      data: permitData,
      gasLimit: permitGas,
      nonce: baseNonce + 1,
      chainId,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };

    const signedClaim = await compromisedWallet.signTransaction(claimTx);
    const signedPermit = await compromisedWallet.signTransaction(permitTx);

    signedBatches.push({ signedClaim, signedPermit });
  }

  // Deploy contract (don't wait for confirmation)
  try {
    const ContractFactory = await ethers.getContractFactory("A", safeWallet);
    const contract = await ContractFactory.deploy(compromisedAddress, {
      value: ethers.parseEther("0.0018"),
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const deployTx = contract.deploymentTransaction();
    console.log(`Deploy tx sent: ${deployTx.hash}`);
  } catch (err) {
    console.error("Deployment failed:", err.message);
    return;
  }

  for (let i = 0; i < signedBatches.length; i++) {
    const { signedClaim, signedPermit } = signedBatches[i];
    console.log(`Trying batch #${i + 1}...`);

    const [res1, res2] = await Promise.all([
      sendTx(provider, signedClaim),
      sendTx(provider, signedPermit),
    ]);

    if (res1 && res2) {
      console.log(`✅ Batch #${i + 1} sent successfully.`);
      console.log(`  Claim Tx Hash: ${res1}`);
      console.log(`  Permit Tx Hash: ${res2}`);
      break; // stop after first success
    } else {
      console.log(`❌ Batch #${i + 1} failed, trying next...`);
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
