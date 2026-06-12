/** Minimal console logger replacing @std/log for Bun. */

export class ConsoleHandler {
  constructor(_level: string) {}
}

export async function setup(_config: unknown): Promise<void> {}

function prefix(level: string): string {
  return `[${level}]`;
}

export const info = (...args: unknown[]) => console.log(prefix("INFO"), ...args);
export const warn = (...args: unknown[]) => console.warn(prefix("WARN"), ...args);
export const error = (...args: unknown[]) => console.error(prefix("ERROR"), ...args);
export const debug = (...args: unknown[]) => console.debug(prefix("DEBUG"), ...args);
