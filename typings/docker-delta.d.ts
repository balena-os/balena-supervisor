declare module 'docker-delta' {
	// Incomplete type definitions
	import type { Duplex } from 'stream';
	import { TypedError } from 'typed-error';

	export class OutOfSyncError extends TypedError {}

	export function applyDelta(
		imageSource: string,
		opts: { log: (str: string) => void; timeout: number },
	): Duplex;
}
