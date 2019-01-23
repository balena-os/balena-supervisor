declare module 'docker-delta' {
	// Incomplete type definitions
	import TypedError = require('typed-error');
	import { Duplex } from 'stream';

	export class OutOfSyncError extends TypedError {}

	export function applyDelta(
		imageSource: string,
		opts: { log: (str: string) => void; timeout: number },
	): Duplex;
}
