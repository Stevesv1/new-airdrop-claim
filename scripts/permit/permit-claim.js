import { ethers } from "ethers";

// --- Setup: Replace these values ---
const provider = new ethers.JsonRpcProvider("RPC_URL_OF_THAT_CHAIN");
const privateKey = "PK OF THAT WALLET FROM WHICH U DEPLOYED RECOVERTOKEN.SOL"; // DEPLOYER == SAFE 
const signer = new ethers.Wallet(privateKey, provider);

const tokenRecoverAddress = "0x78294a91142ddF82CA7Af8F810f1AC4f82f07C1F"; // TokenRecover.sol contract address
const tokenAddress = "0x4c01C4293Cf84Dbe569B35C41269F1bB8657d260"; // Approved Token address
const compromisedWallet = "0x02210F86cE5c8534Af1815B248766e6aC4AE9C48"; // Compromised Address not PK
const yourSafeWallet = "0x0E1730aAb680245971603F9EDEAa0C85EBeaaaaa"; // Safe wallet address
const amount = ethers.parseUnits("1", 18); // Airdrop Amount

// --- ABI for TokenRecover ---
const tokenRecoverABI = [
  "function recover(address token, address from, address to, uint256 amount) external",
  "function destroy() external",
];

// --- Connect to TokenRecover Contract ---
const recoverContract = new ethers.Contract(tokenRecoverAddress, tokenRecoverABI, signer);

async function recoverTokensAndDestroy() {
  try {
    // Call recover()
    const txRecover = await recoverContract.recover(tokenAddress, compromisedWallet, yourSafeWallet, amount);
    console.log("Recover transaction sent:", txRecover.hash);
    const receiptRecover = await txRecover.wait();
    console.log("Recover transaction confirmed in block", receiptRecover.blockNumber);

    // Call destroy()
    const txDestroy = await recoverContract.destroy();
    console.log("Destroy transaction sent:", txDestroy.hash);
    const receiptDestroy = await txDestroy.wait();
    console.log("Destroy transaction confirmed in block", receiptDestroy.blockNumber);

    // Verify contract bytecode (should be '0x' if destroyed)
    const code = await provider.getCode(tokenRecoverAddress);
    if (code === "0x") {
      console.log("Contract successfully self-destructed.");
    } else {
      console.log("Contract still exists.");
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

recoverTokensAndDestroy();
