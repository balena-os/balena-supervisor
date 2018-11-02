import TypedError = require('typed-error');

export interface LockCallback {
	(appId: number, opts: { force: boolean }, fn: () => void): Promise<void>;
}

export class UpdatesLockedError extends TypedError {}

export function lock(): LockCallback;
export function lockPath(appId: number, serviceName: string): string;
