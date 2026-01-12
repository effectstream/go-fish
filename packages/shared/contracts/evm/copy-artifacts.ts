#!/usr/bin/env -S deno run -A
/**
 * Copy Forge artifacts to Hardhat format
 * This is needed because Hardhat compile has Deno compatibility issues,
 * but Hardhat Ignition requires Hardhat-format artifacts.
 */

const __dirname = import.meta.dirname!;

// Create Hardhat artifacts directory structure
await Deno.mkdir(`${__dirname}/build/artifacts/hardhat/contracts`, { recursive: true });
await Deno.mkdir(`${__dirname}/build/artifacts/hardhat/build-info`, { recursive: true });

// Copy contract artifacts from Forge to Hardhat structure
const contracts = ["PaimaL2Contract", "GoFishLobby"];

for (const contract of contracts) {
  const forgePath = `${__dirname}/build/artifacts/forge/contracts/${contract}.sol/${contract}.json`;
  const forgePathAlt = `${__dirname}/build/artifacts/forge/${contract}.sol/${contract}.json`;
  const hardhatPath = `${__dirname}/build/artifacts/hardhat/contracts/${contract}.sol`;

  // Create contract directory
  await Deno.mkdir(hardhatPath, { recursive: true });

  // Try main path first, then alternative
  try {
    await Deno.copyFile(forgePath, `${hardhatPath}/${contract}.json`);
    console.log(`✓ Copied ${contract} from contracts/`);
  } catch {
    try {
      await Deno.copyFile(forgePathAlt, `${hardhatPath}/${contract}.json`);
      console.log(`✓ Copied ${contract} from root`);
    } catch (e) {
      console.error(`✗ Failed to copy ${contract}:`, e);
    }
  }
}

// Create stub build-info files (Hardhat expects .output.json with specific structure)
const buildInfo = {
  _format: "hh3-sol-build-info-output-1",
  id: "stub-build-info",
  output: {
    contracts: {},
    sources: {}
  }
};

await Deno.writeTextFile(
  `${__dirname}/build/artifacts/hardhat/build-info/stub.output.json`,
  JSON.stringify(buildInfo, null, 2)
);

console.log("✓ Hardhat artifacts ready");
