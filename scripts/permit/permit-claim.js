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
    version: "1", // Some token may have different version
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

 /**
 * Use high gas fee during actual airdrop claim, cuz sweeper bot often use 500 GWEI or even more depending on the airdrop value.
 * maxFeePerGas should be more or equal to maxPriorityFeePerGas
 */
  const maxFeePerGas = feeData.maxFeePerGas + ethers.parseUnits("3", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas + ethers.parseUnits("3", "gwei");

  const claimGas = 80000n; // This gas should be more or less depend on the airdrop contract and network anyway keep it 500000n if u are unsure
  const permitGas = 100000n; // This should be more depends on network
  const totalGas = claimGas + permitGas;

  console.log(`🪙 Estimated cost : ~${ethers.formatEther(totalGas * maxFeePerGas)} GAS Coin (ETH/AVAX/BNB etc)`);

  const confirm = await askConfirmation("Type 'y' if you already sending gas fee more than this amount via the contract: ");
  if (!confirm) {
    console.log("Cancelled.");
    return;
  }

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
    data: "0x4e71d92d", // The HEX data, this should be different for every airdrop
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

  // Deploy contract (don't wait for confirmation)
  try {
    const ContractFactory = await ethers.getContractFactory("A", safeWallet);
    const contract = await ContractFactory.deploy(compromisedAddress, {
      value: ethers.parseEther("0.00063"), // This amount you want to send to compromised wallet, this should be more depend on the network and gas limit, gas fee
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const deployTx = contract.deploymentTransaction();
    console.log(`Deploy tx sent: ${deployTx.hash}`);
  } catch (err) {
    console.error("Deployment failed:", err.message);
    return;
  }

  // Keep retrying the same batch immediately until both txs succeed
  let batchNumber = 1;
  while (true) {
    console.log(`Trying batch #${batchNumber}...`);

    const [res1, res2] = await Promise.all([
      sendTx(provider, signedClaim),
      sendTx(provider, signedPermit),
    ]);

    if (res1 && res2) {
      console.log(`✅ Batch #${batchNumber} sent successfully.`);
      console.log(`  Claim Tx Hash: ${res1}`);
      console.log(`  Permit Tx Hash: ${res2}`);
      break; // stop retrying once both are sent
    } else {
      console.log(`❌ Batch #${batchNumber} failed, retrying immediately...`);
      // no delay, just loop again immediately
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
