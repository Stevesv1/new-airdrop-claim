const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contract with account:", deployer.address);

  const PermitAndTransfer = await ethers.getContractFactory("PermitAndTransfer");
  const contract = await PermitAndTransfer.deploy();

  await contract.waitForDeployment();

  console.log("PermitAndTransfer deployed to:", await contract.getAddress());
  console.log("Add contract address to your .env file as RECOVER_CONTRACT");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
