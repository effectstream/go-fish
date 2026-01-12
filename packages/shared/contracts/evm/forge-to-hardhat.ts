#!/usr/bin/env -S deno run -A
/**
 * Convert Forge artifacts to Hardhat format
 * This is needed because Hardhat Ignition requires Hardhat-format artifacts
 */

const __dirname = import.meta.dirname!;

// Create Hardhat artifacts directory structure
await Deno.mkdir(`${__dirname}/build/artifacts/hardhat/contracts`, { recursive: true });
await Deno.mkdir(`${__dirname}/build/artifacts/hardhat/build-info`, { recursive: true });

const contracts = [
  { name: "PaimaL2Contract", source: "contracts/PaimaL2Contract.sol" },
  { name: "GoFishLobby", source: "contracts/GoFishLobby.sol" },
];

const buildInfoId = "stub-build-info";

for (const contract of contracts) {
  // Read Forge artifact - try both paths
  let forgePath = `${__dirname}/build/artifacts/forge/${contract.source}/${contract.name}.json`;
  let forgeArtifact;

  try {
    forgeArtifact = JSON.parse(await Deno.readTextFile(forgePath));
  } catch {
    // Try alternative path without contracts/ subdirectory
    const altSource = contract.source.replace('contracts/', '');
    forgePath = `${__dirname}/build/artifacts/forge/${altSource}/${contract.name}.json`;
    forgeArtifact = JSON.parse(await Deno.readTextFile(forgePath));
  }

  // Convert to Hardhat format
  const hardhatArtifact = {
    _format: "hh-sol-artifact-1",
    contractName: contract.name,
    sourceName: contract.source,
    abi: forgeArtifact.abi,
    bytecode: forgeArtifact.bytecode.object || forgeArtifact.bytecode,
    deployedBytecode: forgeArtifact.deployedBytecode.object || forgeArtifact.deployedBytecode,
    linkReferences: forgeArtifact.bytecode.linkReferences || {},
    deployedLinkReferences: forgeArtifact.deployedBytecode.linkReferences || {},
    immutableReferences: forgeArtifact.deployedBytecode.immutableReferences || {},
    buildInfoId: buildInfoId,
  };

  // Write Hardhat artifact
  const hardhatPath = `${__dirname}/build/artifacts/hardhat/${contract.source}`;
  await Deno.mkdir(hardhatPath, { recursive: true });
  await Deno.writeTextFile(
    `${hardhatPath}/${contract.name}.json`,
    JSON.stringify(hardhatArtifact, null, 2)
  );

  console.log(`✓ Converted ${contract.name}`);
}

// Create proper build-info file
const buildInfo = {
  _format: "hh-sol-build-info-1",
  id: buildInfoId,
  solcVersion: "0.8.27",
  solcLongVersion: "0.8.27",
  input: {
    language: "Solidity",
    sources: {},
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        "*": {
          "*": ["*"],
        },
      },
    },
  },
  output: {
    contracts: {},
    sources: {},
  },
};

// Write both .json and .output.json files (Hardhat needs both)
const buildInfoJson = JSON.stringify(buildInfo, null, 2);
await Deno.writeTextFile(
  `${__dirname}/build/artifacts/hardhat/build-info/${buildInfoId}.json`,
  buildInfoJson
);
await Deno.writeTextFile(
  `${__dirname}/build/artifacts/hardhat/build-info/${buildInfoId}.output.json`,
  buildInfoJson
);

console.log("✓ Build info created");
console.log("✓ Hardhat artifacts ready");
