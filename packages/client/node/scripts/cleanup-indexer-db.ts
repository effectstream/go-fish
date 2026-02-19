/**
 * Cleanup Indexer Database
 *
 * Removes the indexer's SQLite database before startup.
 * This is necessary because when the midnight-node restarts with a fresh
 * chain state (dev mode), the indexer's database becomes stale and causes
 * "ledger state for key B not found" errors.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Get the directory of this script to find go-fish root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goFishRoot = path.resolve(__dirname, "../../../../");

async function main() {
  console.log("[cleanup-indexer-db] Cleaning up stale indexer database...");
  console.log(`[cleanup-indexer-db] Go-fish root: ${goFishRoot}`);
  console.log(`[cleanup-indexer-db] Current working directory: ${Deno.cwd()}`);

  // The indexer stores its database in the npm package's data directory
  // Use absolute paths based on the go-fish project root
  const possiblePaths = [
    // Local node_modules (used by deno with nodeModulesDir) - absolute path
    path.join(goFishRoot, "node_modules/.deno/@paimaexample+npm-midnight-indexer@0.7.0/node_modules/@paimaexample/npm-midnight-indexer/indexer-standalone/data"),
    // Alternative local paths - absolute
    path.join(goFishRoot, "node_modules/@paimaexample/npm-midnight-indexer/indexer-standalone/data"),
    // Deno cached npm package location
    path.join(
      Deno.env.get("HOME") || "",
      ".cache/deno/npm/registry.npmjs.org/@paimaexample/npm-midnight-indexer"
    ),
  ];

  let cleaned = false;

  for (const basePath of possiblePaths) {
    const dataPath = basePath.includes("data") && !basePath.includes("registry")
      ? basePath
      : path.join(basePath, "indexer-standalone/data");

    console.log(`[cleanup-indexer-db] Checking: ${dataPath}`);

    try {
      const stat = await Deno.stat(dataPath);
      if (stat.isDirectory) {
        console.log(`[cleanup-indexer-db] Found indexer data at: ${dataPath}`);
        await Deno.remove(dataPath, { recursive: true });
        console.log(`[cleanup-indexer-db] Removed: ${dataPath}`);
        cleaned = true;
        break; // Stop after first successful cleanup
      }
    } catch {
      // Path doesn't exist, continue
    }
  }

  // Also try to find via directory scan if not cleaned yet
  if (!cleaned) {
    const denoModulesPath = path.join(goFishRoot, "node_modules/.deno");
    console.log(`[cleanup-indexer-db] Scanning: ${denoModulesPath}`);
    try {
      for await (const entry of Deno.readDir(denoModulesPath)) {
        if (entry.name.startsWith("@paimaexample+npm-midnight-indexer")) {
          const dataPath = path.join(
            denoModulesPath,
            entry.name,
            "node_modules/@paimaexample/npm-midnight-indexer/indexer-standalone/data"
          );
          try {
            const stat = await Deno.stat(dataPath);
            if (stat.isDirectory) {
              await Deno.remove(dataPath, { recursive: true });
              console.log(`[cleanup-indexer-db] Removed: ${dataPath}`);
              cleaned = true;
              break;
            }
          } catch {
            // Ignore if doesn't exist
          }
        }
      }
    } catch (e) {
      console.log(`[cleanup-indexer-db] Could not scan deno modules: ${e}`);
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
