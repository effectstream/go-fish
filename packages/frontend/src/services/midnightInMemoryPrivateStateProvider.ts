import type {
  ExportPrivateStatesOptions,
  ExportSigningKeysOptions,
  ImportPrivateStatesOptions,
  ImportPrivateStatesResult,
  ImportSigningKeysOptions,
  ImportSigningKeysResult,
  PrivateStateExport,
  PrivateStateProvider,
  SigningKeyExport,
} from "@midnight-ntwrk/midnight-js-types";
import type { ContractAddress, SigningKey } from "@midnight-ntwrk/compact-runtime";

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function createInMemoryPrivateStateProvider<PSI extends string, PS = any>(
  accountId: string,
): PrivateStateProvider<PSI, PS> {
  const privateStates = new Map<string, PS>();
  const signingKeys = new Map<string, SigningKey>();
  let contractAddress: ContractAddress | null = null;

  function requireContractAddress(): ContractAddress {
    if (!contractAddress) {
      throw new Error(
        "Contract address not set on in-memory private state provider.",
      );
    }

    return contractAddress;
  }

  function privateStateKey(privateStateId: PSI): string {
    return `${accountId}::${requireContractAddress()}::${privateStateId}`;
  }

  function signingKeyKey(address: ContractAddress): string {
    return `${accountId}::${address}`;
  }

  return {
    setContractAddress(address: ContractAddress): void {
      contractAddress = address;
    },
    async set(privateStateId: PSI, state: PS): Promise<void> {
      privateStates.set(privateStateKey(privateStateId), cloneValue(state));
    },
    async get(privateStateId: PSI): Promise<PS | null> {
      const state = privateStates.get(privateStateKey(privateStateId));
      return state == null ? null : cloneValue(state);
    },
    async remove(privateStateId: PSI): Promise<void> {
      privateStates.delete(privateStateKey(privateStateId));
    },
    async clear(): Promise<void> {
      const prefix = `${accountId}::${requireContractAddress()}::`;
      for (const key of Array.from(privateStates.keys())) {
        if (key.startsWith(prefix)) {
          privateStates.delete(key);
        }
      }
    },
    async setSigningKey(
      address: ContractAddress,
      signingKey: SigningKey,
    ): Promise<void> {
      signingKeys.set(signingKeyKey(address), signingKey);
    },
    async getSigningKey(address: ContractAddress): Promise<SigningKey | null> {
      return signingKeys.get(signingKeyKey(address)) ?? null;
    },
    async removeSigningKey(address: ContractAddress): Promise<void> {
      signingKeys.delete(signingKeyKey(address));
    },
    async clearSigningKeys(): Promise<void> {
      const prefix = `${accountId}::`;
      for (const key of Array.from(signingKeys.keys())) {
        if (key.startsWith(prefix)) {
          signingKeys.delete(key);
        }
      }
    },
    async exportPrivateStates(
      _options?: ExportPrivateStatesOptions,
    ): Promise<PrivateStateExport> {
      throw new Error(
        "In-memory private state provider does not support export.",
      );
    },
    async importPrivateStates(
      _exportData: PrivateStateExport,
      _options?: ImportPrivateStatesOptions,
    ): Promise<ImportPrivateStatesResult> {
      throw new Error(
        "In-memory private state provider does not support import.",
      );
    },
    async exportSigningKeys(
      _options?: ExportSigningKeysOptions,
    ): Promise<SigningKeyExport> {
      throw new Error("In-memory private state provider does not support export.");
    },
    async importSigningKeys(
      _exportData: SigningKeyExport,
      _options?: ImportSigningKeysOptions,
    ): Promise<ImportSigningKeysResult> {
      throw new Error("In-memory private state provider does not support import.");
    },
  };
}
