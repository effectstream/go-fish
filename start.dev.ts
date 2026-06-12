import path from "node:path";
import type { OrchestratorConfig } from "@effectstream/orchestrator/config";
import { launchPglite, DbNames } from "@effectstream/orchestrator/launch-pglite";
import { launchEvm, EvmNames } from "@effectstream/orchestrator/launch-evm";
import { launchMidnight, MidnightNames } from "@effectstream/orchestrator/launch-midnight";

const root = import.meta.dirname!;
const evmContractsDir = path.join(root, "packages/shared/contracts/evm");
const midnightContractsDir = path.join(root, "packages/shared/contracts/midnight");
const useTypescriptContract = process.env.USE_TYPESCRIPT_CONTRACT === "true";
const skipMidnightInfra = process.env.SKIP_MIDNIGHT_INFRA === "true";

const midnightDeps = skipMidnightInfra || useTypescriptContract
  ? []
  : [MidnightNames.CONTRACT_DEPLOY];

export default {
  processes: [
    ...launchPglite().map((p) =>
      p.name === "pglite"
        ? { ...p, env: { ...p.env, DEBUG_PGLITE: "0", USE_DB_STARTHEIGHT: "true" } }
        : p
    ),
    ...launchEvm("@go-fish/evm-contracts", { cwd: evmContractsDir }),
    ...(skipMidnightInfra || useTypescriptContract
      ? []
      : launchMidnight("@go-fish/midnight-contracts", { cwd: midnightContractsDir })),

    {
      name: "sync",
      description: "Go Fish sync node",
      args: ["run", "packages/client/node/src/main.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      env: {
        PGLITE: "true",
        EFFECTSTREAM_ENV: "dev",
        EFFECTSTREAM_API_PORT: "9996",
        NODE_ENV: "development",
        USE_DB_STARTHEIGHT: "true",
        ...(useTypescriptContract ? { USE_TYPESCRIPT_CONTRACT: "true" } : {}),
        ...(skipMidnightInfra ? { SKIP_MIDNIGHT_INFRA: "true" } : {}),
      },
      dependsOn: [
        DbNames.PGLITE_WAIT,
        EvmNames.GENERATE_MOD,
        ...midnightDeps,
      ],
    },

    {
      name: "batcher",
      description: "Transaction batcher (EVM + Midnight)",
      args: ["run", "--filter", "@go-fish/batcher", "start"],
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:3336",
      stopProcessAtPort: [3336],
      env: { EFFECTSTREAM_ENV: "dev", BATCHER_PORT: "3336" },
      dependsOn: [EvmNames.GENERATE_MOD, ...midnightDeps],
    },
  ],
} satisfies OrchestratorConfig;
