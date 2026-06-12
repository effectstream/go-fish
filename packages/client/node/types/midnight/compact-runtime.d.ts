declare module "@midnight-ntwrk/compact-runtime" {
  export class CircuitContext<T = any> {
    currentQueryContext: any;
    currentPrivateState: any;
    currentZswapLocalState: any;
    costModel: any;
    constructor(...args: any[]);
  }
  export class WitnessContext<T = any> {
    constructor(...args: any[]);
  }
  export class QueryContext {
    constructor(...args: any[]);
  }
  export class CostModel {
    static initialCostModel(): CostModel;
    constructor(...args: any[]);
  }
  export const createConstructorContext: any;
  export const sampleContractAddress: any;
}

declare module "../../../shared/contracts/midnight/go-fish-contract/src/managed/contract/index.js" {
  export class Contract {
    constructor(...args: any[]);
    [key: string]: any;
  }
  export const ledger: any;
  const _default: any;
  export default _default;
}
