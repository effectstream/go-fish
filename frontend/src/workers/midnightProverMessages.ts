export type MidnightProverWorkerRequest =
  | {
      type: "init";
      baseUrl: string;
    }
  | {
      type: "prove";
      requestId: number;
      serializedTx: ArrayBuffer;
    };

export type MidnightProverWorkerResponse =
  | {
      type: "ready";
    }
  | {
      type: "result";
      requestId: number;
      serializedTx: ArrayBuffer;
    }
  | {
      type: "error";
      message: string;
      requestId?: number;
    };
