import { endsWith, map } from 'lodash';
import { Response } from 'request';
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

export class DeviceNotFoundError extends TypedError {}

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

export function isHttpConflictError(err: StatusCodeError | Response): boolean {
	return checkInt(err.statusCode) === 409;
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

export class ImageAuthenticationError extends TypedError {}

/**
 * An error thrown if our own container cannot be inspected.
 * See LocalModeManager for a usage example.
 */
export class SupervisorContainerNotFoundError extends TypedError {}

/**
 * This error is thrown when a container contract does not
 * match the minimum we expect from it
 */
export class ContractValidationError extends TypedError {
	constructor(serviceName: string, error: string) {
		super(
			`The contract for service ${serviceName} failed validation, with error: ${error}`,
		);
	}
}

/**
 * This error is thrown when one or releases cannot be ran
 * as one or more of their container have unmet requirements.
 * It accepts a map of app names to arrays of service names
 * which have unmet requirements.
 */
export class ContractViolationError extends TypedError {
	constructor(violators: { [appName: string]: string[] }) {
		const appStrings = map(
			violators,
			(svcs, name) =>
				`${name}: Services with unmet requirements: ${svcs.join(', ')}`,
		);
		super(
			`Some releases were rejected due to having unmet requirements:\n  ${appStrings.join(
				'\n  ',
			)}`,
		);
	}
}

export class AppsJsonParseError extends TypedError {}
export class DatabaseParseError extends TypedError {}
export class BackupError extends TypedError {}

export class ExtLinuxParseError extends TypedError {}
export class AppendDirectiveError extends TypedError {}
export class FDTDirectiveError extends TypedError {}
