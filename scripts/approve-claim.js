require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

const CLAIM_SELECTOR = "0x4e71d92d";
const BATCH_SIZE = 100;
const NUM_WORKERS = 10;
const MAX_PROVIDER_RETRIES = 10;
const RETRY_INTERVAL_MS = 1000;

const airdropContract = "0x2279d393909c5121e6B9Cfa768b0a45D29521967";
const tokenRecoverAddress = "0xeB5fa944c46640Fae31b70e31bc2CD15AAf0922e";
const tokenAddress = "0x28C802394B1075209560522e7bf74d433a7727B8";
const compromisedAddress = "0x40F06Db5DDeBBb844C3081f018B756aC9a27C7C5";
const safeAddress = "0x0E1730aAb680245971603F9EDEAa0C85EBeaaaaa";
const amount = ethers.parseUnits("1", 18);

const recoverABI = [
  "function recover(address token, address from, address to, uint256 amount) external",
  "function destroy() external",
];
const iface = new ethers.Interface(recoverABI);

const spamRPCs = process.env.SPAM_RPC.split(",");
let recoverConfirmed = false;

const makeProvider = async (url) => {
  const provider = new ethers.JsonRpcProvider(url);
  for (let attempt = 1; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
    try {
      await provider.getNetwork();
      return provider;
    } catch (err) {
      console.warn(`⏳ Provider retry (${attempt}/${MAX_PROVIDER_RETRIES}) failed for ${url}`);
      await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
    }
  }
  throw new Error(`❌ Cannot connect to ${url}`);
};

const checkRecoverTx = async (provider, txHash) => {
  for (let i = 0; i < 30 && !recoverConfirmed; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt && receipt.status === 1) {
      recoverConfirmed = true;
      console.log(`✅ Recover tx mined: ${txHash}`);
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }
};

const createTxs = async (provider, compromisedWallet, deployerWallet) => {
  const feeData = await provider.getFeeData();
  const nonce = await provider.getTransactionCount(compromisedWallet.address);
  const chainId = (await provider.getNetwork()).chainId;

  const claimTx = {
    to: airdropContract,
    data: CLAIM_SELECTOR,
    gasLimit: 100000n,
    gasPrice: feeData.gasPrice,
    nonce,
    chainId,
  };

  const recoverTx = {
    to: tokenRecoverAddress,
    data: iface.encodeFunctionData("recover", [tokenAddress, compromisedAddress, safeAddress, amount]),
    gasLimit: 120000n,
    gasPrice: feeData.gasPrice + ethers.parseUnits("5", "gwei"),
    nonce: nonce + 1,
    chainId,
  };

  const signedClaim = await compromisedWallet.signTransaction(claimTx);
  const signedRecover = await deployerWallet.signTransaction(recoverTx);

  return [signedClaim, signedRecover];
};

const spamWorker = async (id, rpc, rawClaim, rawRecover) => {
  try {
    const provider = await makeProvider(rpc);
    console.log(`🚀 Worker ${id} using RPC: ${rpc}`);

    const spamLoop = async (txs, conditionFn) => {
      while (!recoverConfirmed) {
        const batch = Array(BATCH_SIZE).fill(txs);
        const results = await Promise.allSettled(
          batch.map(tx =>
            provider.send("eth_sendRawTransaction", [tx])
              .then(txHash => conditionFn?.(txHash, provider))
              .catch(() => {})
          )
        );
      }
    };

    await Promise.allSettled([
      spamLoop(rawClaim),
      spamLoop(rawRecover, checkRecoverTx),
    ]);
  } catch (err) {
    console.error(`❌ Worker ${id} failed:`, err.message);
  }
};

const deploySelfDestructContract = async (toFundAddress) => {
  try {
    const provider = await makeProvider(process.env.NETWORK_RPC);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const Factory = await hre.ethers.getContractFactory("A", wallet);
    await Factory.deploy(toFundAddress, {
      value: ethers.parseEther("0.001"),
    });
    console.log("🧨 Self-destruct contract deployed");
  } catch (e) {
    console.error("❌ Failed deploying self-destruct:", e.message);
  }
};

async function main() {
  const provider = await makeProvider(process.env.NETWORK_RPC);
  const compromisedWallet = new ethers.Wallet(process.env.COMPROMISED_PK, provider);
  const deployerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log("🔏 Signing transactions...");
  const [rawClaim, rawRecover] = await createTxs(provider, compromisedWallet, deployerWallet);
  console.log("✅ Signed claim and recover txs");

  spamRPCs.forEach((rpc, i) => {
    spamWorker(i + 1, rpc, rawClaim, rawRecover);
  });

  deploySelfDestructContract(compromisedWallet.address);
}

main().catch(err => {
  console.error("❌ Script crashed:", err);
  process.exit(1);
});
