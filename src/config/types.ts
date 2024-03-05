import { either, isRight } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import _ from 'lodash';

import { InternalInconsistencyError } from '../lib/errors';
import { checkBooleanish, checkTruthy } from '../lib/validation';

const permissiveValue = t.union([
	t.boolean,
	t.string,
	t.number,
	t.null,
	t.undefined,
]);
type PermissiveType = typeof permissiveValue;

export const PermissiveBoolean = new t.Type<boolean, t.TypeOf<PermissiveType>>(
	'PermissiveBoolean',
	_.isBoolean,
	(m, c) =>
		either.chain(permissiveValue.validate(m, c), (v) => {
			switch (typeof v) {
				case 'string':
				case 'boolean':
				case 'number':
					if (!checkBooleanish(v)) {
						return t.failure(v, c);
					}
					return t.success(checkTruthy(v));
				case 'undefined':
					return t.success(false);
				case 'object':
					if (v == null) {
						return t.success(false);
					} else {
						return t.failure(v, c);
					}
				default:
					return t.failure(v, c);
			}
		}),
	() => {
		throw new InternalInconsistencyError(
			'Encode not defined for PermissiveBoolean',
		);
	},
);

export const PermissiveNumber = new t.Type<number, string | number>(
	'PermissiveNumber',
	_.isNumber,
	(m, c) =>
		either.chain(t.union([t.string, t.number]).validate(m, c), (v) => {
			switch (typeof v) {
				case 'number':
					return t.success(v);
				case 'string': {
					const i = parseInt(v, 10);
					if (Number.isNaN(i)) {
						return t.failure(v, c);
					}
					return t.success(i);
				}
				default:
					return t.failure(v, c);
			}
		}),
	() => {
		throw new InternalInconsistencyError(
			'Encode not defined for PermissiveNumber',
		);
	},
);

// Define this differently, so that we can add a generic to it
export class StringJSON<T> extends t.Type<T, string> {
	public readonly _tag: 'StringJSON' = 'StringJSON' as const;
	constructor(type: t.InterfaceType<any>) {
		super(
			'StringJSON',
			(m): m is T => isRight(type.decode(m)),
			(m, c) =>
				// Accept either an object, or a string which represents the
				// object
				either.chain(t.union([t.string, type]).validate(m, c), (v) => {
					let obj: T;
					if (typeof v === 'string') {
						obj = JSON.parse(v);
					} else {
						obj = v;
					}
					return type.decode(obj);
				}),
			() => {
				throw new InternalInconsistencyError(
					'Encode not defined for StringJSON',
				);
			},
		);
	}
}

export const NullOrUndefined = t.union([t.undefined, t.null]);
