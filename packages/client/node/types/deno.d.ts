declare const Deno: {
  readTextFileSync(path: string): string;
  writeTextFileSync(path: string, data: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readTextFile(path: string | URL): Promise<string>;
  Command: new (...args: any[]) => {
    spawn(): { status: Promise<{ success: boolean; code: number }> };
  };
};
