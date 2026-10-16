import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { network } from "hardhat";
import { getAddress, keccak256, toHex, type Address } from "viem";

const { viem, networkName } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer, defaultRelayer] = await viem.getWalletClients();

if (!deployer) throw new Error("No deployer account configured for this network");
if (!defaultRelayer && !process.env.RELAYER_ADDRESS) {
  throw new Error("Set RELAYER_ADDRESS (the backend relayer wallet) to deploy on this network");
}

const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const baseUri = `${publicBaseUrl}/metadata/`;
const relayer: Address = process.env.RELAYER_ADDRESS
  ? getAddress(process.env.RELAYER_ADDRESS)
  : defaultRelayer!.account.address;

console.log(`Deploying TicketChain to ${networkName} from ${deployer.account.address}...`);

const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction("TicketChain", [
  baseUri,
]);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });

const RELAYER_ROLE = keccak256(toHex("RELAYER_ROLE"));
const grantHash = await contract.write.grantRole([RELAYER_ROLE, relayer]);
await publicClient.waitForTransactionReceipt({ hash: grantHash });

const chainId = await publicClient.getChainId();
const deployment = {
  address: contract.address,
  deployBlock: Number(receipt.blockNumber),
  chainId,
};

const outDir = path.resolve(import.meta.dirname, "..", "deployments");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `${networkName}.json`);
await writeFile(outFile, JSON.stringify(deployment, null, 2) + "\n");

console.log(
  `TicketChain deployed at ${contract.address} (block ${receipt.blockNumber}, chain ${chainId})`,
);
console.log(`RELAYER_ROLE granted to ${relayer}`);
console.log(`Base URI: ${baseUri}`);
console.log(`Wrote ${path.relative(process.cwd(), outFile)}`);
