import type { AppLogger } from './index.js';

export function runtimeInfo(logger: AppLogger, message: string, ...args: unknown[]): void {
  logger.info(message, ...args);
  console.info(message, ...args);
}

export function runtimeError(logger: AppLogger, message: string, ...args: unknown[]): void {
  logger.error(message, ...args);
  console.error(message, ...args);
}

export function runtimeWarn(logger: AppLogger, message: string, ...args: unknown[]): void {
  logger.warn(message, ...args);
  console.warn(message, ...args);
}
