import { PaimaL2DefaultAdapter } from "@paimaexample/batcher";
import * as chains from "viem/chains";

// For NTP-only development, we use a minimal adapter configuration
// In production with EVM, this would connect to a real Effectstream L2 contract
const mockAddress = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const mockPrivateKey = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
const paimaL2Fee = 0n;
const paimaSyncProtocolName = "mainNtp";

// Using hardhat chain as placeholder for NTP mode
export const effectstreaml2Adapter = new PaimaL2DefaultAdapter(
  mockAddress,
  mockPrivateKey,
  paimaL2Fee,
  paimaSyncProtocolName,
  chains.hardhat,
);
