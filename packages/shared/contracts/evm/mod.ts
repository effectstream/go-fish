// this is a auto-generated file.
import fs from "node:fs";
export * from "./build/mod.ts";
export { contracts } from "./build/contracts.ts";
const __dirname = import.meta.dirname ?? "";
export const contractAddressesEvmMain: () => Record<
"chain31337" | "chain42161", 
  Record<string, `0x${string}`>> = () => {

  const file1 = __dirname + "/ignition/deployments/chain-31337/deployed_addresses.json";
  const file2 = __dirname + "/ignition/deployments/chain-42161/deployed_addresses.json";

  let chain31337: Record<string, `0x${string}`> = {};
  let chain42161: Record<string, `0x${string}`> = {};

  
  if (fs.statSync(file1).isFile()) {
    chain31337 = JSON.parse(fs.readFileSync(file1, 'utf-8'));
  }

  if (fs.statSync(file2).isFile()) {
    chain42161 = JSON.parse(fs.readFileSync(file2, 'utf-8'));
  }

  return {
    chain31337,
    chain42161
  };
}
