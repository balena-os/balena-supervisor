// This module is for compose specific errors, but compose modules
// will still use errors from the global ./lib/errors.ts

import { TypedError } from 'typed-error';

export class InvalidNetworkNameError extends TypedError {
	public constructor(public name: string) {
		super(`Invalid network name: ${name}`);
	}
}

export class ResourceRecreationAttemptError extends TypedError {
	public constructor(
		public resource: string,
		public name: string,
	) {
		super(
			`Trying to create ${resource} with name: ${name}, but a ${resource} ` +
				'with that name and a different configuration already exists',
		);
	}
}

export class InvalidNetworkConfigurationError extends TypedError {}

export class ImageDownloadBackoffError extends TypedError {}
