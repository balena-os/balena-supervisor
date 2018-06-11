import { endsWith } from 'lodash';

import { checkInt } from './validation';

export function NotFoundError(err: { statusCode?: string }): boolean {
	return checkInt(err.statusCode) === 404;
}

export function ENOENT(err: { code: string, [key: string]: any }): boolean {
	return err.code === 'ENOENT';
}

export function EEXIST(err: { code: string, [key: string]: any }): boolean {
	return err.code === 'EEXIST';
}

export function UnitNotLoadedError(err: string[]): boolean {
	return endsWith(err[0], 'not loaded.');
}
