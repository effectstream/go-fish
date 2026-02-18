import { AddressType } from "jsr:@paimaexample/utils@^0.3.128";

export interface DefaultBatcherInput {
  addressType: AddressType;
  input: string;
  signature?: string;
  address: string;
  timestamp: string;
  target?: string; // Optional since by default we will target the PaimaL2 contract
}
