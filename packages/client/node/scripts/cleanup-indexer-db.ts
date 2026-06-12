/**
 * Cleanup Indexer Database
 *
 * Removes the indexer's SQLite database before startup.
 * This is necessary because when the midnight-node restarts with a fresh
 * chain state (dev mode), the indexer's database becomes stale and causes
 * "ledger state for key B not found" errors.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Get the directory of this script to find go-fish root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goFishRoot = path.resolve(__dirname, "../../../../");

async function removeIfDirectory(dataPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dataPath);
    if (stat.isDirectory()) {
      console.log(`[cleanup-indexer-db] Found indexer data at: ${dataPath}`);
      await fs.rm(dataPath, { recursive: true });
      console.log(`[cleanup-indexer-db] Removed: ${dataPath}`);
      return true;
    }
  } catch {
    // Path doesn't exist, continue
  }
  return false;
}

async function main() {
  console.log("[cleanup-indexer-db] Cleaning up stale indexer database...");
  console.log(`[cleanup-indexer-db] Go-fish root: ${goFishRoot}`);
  console.log(`[cleanup-indexer-db] Current working directory: ${process.cwd()}`);

  const possiblePaths = [
    path.join(goFishRoot, "node_modules/@effectstream/npm-midnight-indexer/indexer-standalone/data"),
    path.join(
      goFishRoot,
      "packages/shared/contracts/midnight/node_modules/@effectstream/npm-midnight-indexer/indexer-standalone/data",
    ),
  ];

  let cleaned = false;

  for (const dataPath of possiblePaths) {
    console.log(`[cleanup-indexer-db] Checking: ${dataPath}`);
    if (await removeIfDirectory(dataPath)) {
      cleaned = true;
      break;
    }
  }

  if (!cleaned) {
    const nodeModulesRoot = path.join(goFishRoot, "node_modules");
    console.log(`[cleanup-indexer-db] Scanning: ${nodeModulesRoot}`);
    try {
      for (const entry of await fs.readdir(nodeModulesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name !== "@effectstream") continue;
        const dataPath = path.join(
          nodeModulesRoot,
          "@effectstream/npm-midnight-indexer/indexer-standalone/data",
        );
        if (await removeIfDirectory(dataPath)) {
          cleaned = true;
          break;
        }
      }
    } catch (e) {
      console.log(`[cleanup-indexer-db] Could not scan node_modules: ${e}`);
    }
  }

  if (cleaned) {
    console.log("[cleanup-indexer-db] Cleanup complete!");
  } else {
    console.log("[cleanup-indexer-db] No stale database found (first run or already clean)");
  }
}

main().catch((err) => {
  console.error("[cleanup-indexer-db] Error:", err);
  // Don't exit with error - cleanup failure shouldn't block startup
});
