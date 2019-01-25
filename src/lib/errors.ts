import { endsWith, startsWith } from 'lodash';
import TypedError = require('typed-error');

import { checkInt } from './validation';

// To keep the bluebird typings happy, we need to accept
// an error, and in this case, it would also contain a status code
export interface StatusCodeError extends Error {
	statusCode?: string | number;
}

interface CodedSysError extends Error {
	code?: string;
}

export function NotFoundError(err: StatusCodeError): boolean {
	return checkInt(err.statusCode) === 404;
}

export function ENOENT(err: CodedSysError): boolean {
	return err.code === 'ENOENT';
}

export function EEXIST(err: CodedSysError): boolean {
	return err.code === 'EEXIST';
}

export function EISDIR(err: CodedSysError): boolean {
	return err.code === 'EISDIR';
}

export function UnitNotLoadedError(err: string[]): boolean {
	return endsWith(err[0], 'not loaded.');
}

export class InvalidNetGatewayError extends TypedError {}

export class DeltaStillProcessingError extends TypedError {}

export class InvalidAppIdError extends TypedError {
	public constructor(public appId: any) {
		super(`Invalid appId: ${appId}`);
	}
}

export class UpdatesLockedError extends TypedError {}

export function DuplicateUuidError(err: Error) {
	return startsWith(err.message, '"uuid" must be unique');
}

export class ExchangeKeyError extends TypedError {}

export class InternalInconsistencyError extends TypedError {}

export class ConfigurationValidationError extends TypedError {
	public constructor(key: string, value: unknown) {
		super(
			`There was an error validating configuration input for key: ${key}, with value: ${value}`,
		);
	}
}
