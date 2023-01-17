import { isRight } from 'fp-ts/lib/Either';
import * as _ from 'lodash';
import { DeviceName } from '../types';
export interface CheckIntOptions {
	positive?: boolean;
}

const NUMERALS_REGEX = /^-?[0-9]+\.?0*$/; // Allows trailing 0 decimals
const TRUTHY = ['1', 'true', true, 'on', 1];
const FALSEY = ['0', 'false', false, 'off', 0];

/**
 * checkInt
 *
 * Check an input string as a number, optionally specifying a requirement
 * to be positive
 */
export function checkInt(
	s: unknown,
	options: CheckIntOptions = {},
): number | undefined {
	// Check for non-numeric characters
	if (!NUMERALS_REGEX.test(s as string)) {
		return;
	}

	const i = Number(s);

	if (!Number.isInteger(i)) {
		return;
	}

	if (options.positive && i <= 0) {
		return;
	}

	return i;
}

/**
 * checkString
 *
 * Check that a string exists, and is not an empty string, 'null', or 'undefined'
 */
export function checkString(s: unknown): string | undefined {
	if (s == null || !_.isString(s) || _.includes(['null', 'undefined', ''], s)) {
		return;
	}

	return s;
}

/**
 * checkBooleanish
 *
 * Given an unknown value, determine if it can be evaluated to truthy/falsey.
 *
 */
export function checkBooleanish(v: unknown): boolean {
	return checkTruthy(v) || checkFalsey(v);
}

/**
 * checkTruthy
 *
 * Given an unknown value, determine if it evaluates to true.
 *
 */
export function checkTruthy(v: unknown): boolean {
	if (typeof v === 'string') {
		v = v.toLowerCase();
	}
	return TRUTHY.includes(v as any);
}

/**
 * checkFalsey
 *
 * Given an unknown value, determine if it evaluates to false.
 *
 */
export function checkFalsey(v: unknown): boolean {
	if (typeof v === 'string') {
		v = v.toLowerCase();
	}
	return FALSEY.includes(v as any);
}

export function isValidDeviceName(v: unknown): v is DeviceName {
	return isRight(DeviceName.decode(v));
}

/**
 * validStringOrUndefined
 *
 * Ensure a string is either undefined, or a non-empty string
 */
export function validStringOrUndefined(s: string | undefined): boolean {
	return _.isUndefined(s) || (_.isString(s) && !_.isEmpty(s));
}

/**
 * validStringOrUndefined
 *
 * Ensure an object is either undefined or an actual object
 */
export function validObjectOrUndefined(o: object | undefined): boolean {
	return _.isUndefined(o) || _.isObject(o);
}
