import { endsWith } from 'lodash';
import { TypedError } from 'typed-error';

import { checkInt } from './validation';

// To keep the bluebird typings happy, we need to accept
// an error, and in this case, it would also contain a status code
export interface StatusCodeError extends Error {
	statusCode?: string | number;
}

export class StatusError extends Error {
	constructor(
		public statusCode: number,
		public statusMessage?: string,
		public retryAfter?: number,
	) {
		super(statusMessage);
	}
}

export const isStatusError = (x: unknown): x is StatusError =>
	x != null && x instanceof Error && !isNaN((x as any).statusCode);

export class NotFoundError extends StatusError {
	constructor(statusMessage?: string) {
		super(404, statusMessage ?? 'Not Found');
	}
}

export const isNotFoundError = (e: unknown): e is NotFoundError =>
	isStatusError(e) && e.statusCode === 404;

export class BadRequestError extends StatusError {
	constructor(statusMessage?: string) {
		super(400, statusMessage ?? 'Bad Request');
	}
}

export const isBadRequestError = (e: unknown): e is BadRequestError =>
	isStatusError(e) && e.statusCode === 400;

export class DeviceNotFoundError extends TypedError {}

interface CodedSysError extends Error {
	code?: string;
}

const isCodedSysError = (e: unknown): e is CodedSysError =>
	// See https://mdn.io/hasOwn
	e != null && e instanceof Error && Object.hasOwn(e, 'code');

export const isENOENT = (e: unknown): e is CodedSysError =>
	isCodedSysError(e) && e.code === 'ENOENT';

export const isEEXIST = (e: unknown): e is CodedSysError =>
	isCodedSysError(e) && e.code === 'EEXIST';

export const isEISDIR = (e: unknown): e is CodedSysError =>
	isCodedSysError(e) && e.code === 'EISDIR';

export const isEPERM = (e: unknown): e is CodedSysError =>
	isCodedSysError(e) && e.code === 'EPERM';

export function UnitNotLoadedError(err: string[]): boolean {
	return endsWith(err[0], 'not loaded.');
}

export class InvalidNetGatewayError extends TypedError {}

export class DeltaStillProcessingError extends TypedError {}

export class DeltaServerError extends StatusError {}

export class UpdatesLockedError extends TypedError {}

export function isHttpConflictError(err: { statusCode: number }): boolean {
	return checkInt(err.statusCode) === 409;
}

export class FailedToProvisionDeviceError extends TypedError {
	public constructor() {
		super('Failed to provision device');
	}
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

export class TargetStateError extends TypedError {}

/**
 * An error thrown if our own container cannot be inspected.
 * See LocalModeManager for a usage example.
 */
export class SupervisorContainerNotFoundError extends TypedError {}

export class AppsJsonParseError extends TypedError {}
export class DatabaseParseError extends TypedError {}
export class BackupError extends TypedError {}

/**
 * Thrown if we cannot parse an extlinux file.
 */
export class ExtLinuxParseError extends TypedError {}

/**
 * Thrown if there is a problem with the environment of which extlinux config is in.
 * This can be things like missing config files or config files we cannot write to.
 */
export class ExtLinuxEnvError extends TypedError {}

/**
 * Thrown if we cannot parse the APPEND directive from a extlinux file
 */
export class AppendDirectiveError extends TypedError {}

/**
 * Thrown if we cannot parse the FDT directive from a extlinux file
 */
export class FDTDirectiveError extends TypedError {}

/**
 * Generic error thrown when something goes wrong with handling the ExtraUEnv backend.
 * This can be things like missing config files or config files we cannot write to.
 */
export class ExtraUEnvError extends TypedError {}

/**
 * Generic error thrown when something goes wrong with handling the ODMDATA backend.
 * This can be things like missing config files or config files we cannot write to.
 */
export class ODMDataError extends TypedError {}
