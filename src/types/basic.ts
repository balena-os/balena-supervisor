import * as t from 'io-ts';
import { chain, fold, isRight, left, right, Either } from 'fp-ts/lib/Either';
import { pipe, flow } from 'fp-ts/function';

/**
 * A short string is a non null string between
 * 0 and 255 characters
 */
export const ShortString = new t.Type<string, string>(
	'ShortString',
	(i: unknown): i is string => t.string.is(i) && i.length <= 255,
	(i, c) =>
		pipe(
			t.string.validate(i, c),
			chain((s) =>
				s.length <= 255
					? t.success(s)
					: t.failure(s, c, 'must be at most 255 chars long'),
			),
		),
	t.identity,
);

// Note: assigning this type to a string will not throw compilation errorrs.
//
// e.g. the following will compile without issues.
// ```
// const x: ShortString = 'a'.repeat(300);
// ```
export type ShortString = t.TypeOf<typeof ShortString>;

/**
 * A string identifier is a string that encodes a
 * positive integer (an id to be used as a database id)
 *
 * e.g.
 * Invalid decimal strings: 'aaa', '0xaaa'
 * Valid decimal strings: '0', '123'
 */
export const StringIdentifier = new t.Type<string, string>(
	'StringIdentifier',
	(i: unknown): i is string =>
		t.string.is(i) && !isNaN(+i) && +i === parseInt(i, 10) && +i >= 0,
	(i, c) =>
		pipe(
			t.string.validate(i, c),
			chain((s) =>
				!isNaN(+s) && +s === parseInt(s, 10) && +s >= 0
					? t.success(s)
					: t.failure(s, c, 'must be be an positive integer'),
			),
		),
	String,
);

export type StringIdentifier = t.TypeOf<typeof StringIdentifier>;

export const StringOrNumber = t.union([t.number, t.string]);
export type StringOrNumber = t.TypeOf<typeof StringOrNumber>;

/**
 * A numeric identifier is any valid identifier encoded as a string or number
 */
export const NumericIdentifier = new t.Type<number, StringOrNumber>(
	'NumericIdentifier',
	(i): i is number =>
		StringOrNumber.is(i) &&
		!isNaN(+i) &&
		+i === parseInt(String(i), 10) &&
		+i >= 0,
	(i, c) =>
		pipe(
			StringOrNumber.validate(i, c),
			chain((n) =>
				!isNaN(+n) && +n === parseInt(String(n), 10) && +n >= 0
					? t.success(+n)
					: t.failure(n, c, 'must be be an positive integer'),
			),
		),
	Number,
);
export type NumericIdentifier = t.TypeOf<typeof NumericIdentifier>;

/**
 * Valid variable names are between 0 and 255 characters
 * and match /^[a-zA-Z_][a-zA-Z0-9_]*$/
 */
const VAR_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const VariableName = new t.Type<string, string>(
	'VariableName',
	(s: unknown): s is string => ShortString.is(s) && VAR_NAME_REGEX.test(s),
	(i, c) =>
		pipe(
			ShortString.validate(i, c),
			chain((s) =>
				VAR_NAME_REGEX.test(s)
					? t.success(s)
					: t.failure(
							s,
							c,
							"needs to start with a letter and may only contain alphanumeric characters plus '_'",
					  ),
			),
		),
	t.identity,
);
export type VariableName = t.TypeOf<typeof VariableName>;

/**
 * Valid label names are between 0 and 255 characters
 * and match /^[a-zA-Z][a-zA-Z0-9\.\-]*$/
 */
const LABEL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9\.\-]*$/;

export const LabelName = new t.Type<string, string>(
	'LabelName',
	(s: unknown): s is string => ShortString.is(s) && LABEL_NAME_REGEX.test(s),
	(i, c) =>
		pipe(
			ShortString.validate(i, c),
			chain((s) =>
				LABEL_NAME_REGEX.test(s)
					? t.success(s)
					: t.failure(
							s,
							c,
							"needs to start with a letter and may only contain alphanumeric characters plus '-' and '.'",
					  ),
			),
		),
	t.identity,
);
export type LabelName = t.TypeOf<typeof LabelName>;

/**
 * An env var object is a dictionary with valid variables as keys
 */
export const EnvVarObject = t.record(VariableName, t.string);
export type EnvVarObject = t.TypeOf<typeof EnvVarObject>;

/**
 * An env var object is a dictionary with valid labels as keys
 */
export const LabelObject = t.record(LabelName, t.string);
export type LabelObject = t.TypeOf<typeof LabelObject>;

// Valid docker container and volume name according to
// https://github.com/moby/moby/blob/04c6f09fbdf60c7765cc4cb78883faaa9d971fa5/daemon/daemon.go#L56
// [a-zA-Z0-9][a-zA-Z0-9_.-]
const DOCKER_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_\.\-]*$/;
export const DockerName = new t.Type<string, string>(
	'DockerName',
	(s: unknown): s is string => ShortString.is(s) && DOCKER_NAME_REGEX.test(s),
	(i, c) =>
		pipe(
			ShortString.validate(i, c),
			chain((s) =>
				DOCKER_NAME_REGEX.test(s)
					? t.success(s)
					: t.failure(s, c, 'only "[a-zA-Z0-9][a-zA-Z0-9_.-]" are allowed'),
			),
		),
	t.identity,
);
export type DockerName = t.TypeOf<typeof DockerName>;

/**
 * Device name can have any characters except '\n'
 */
export const DeviceName = new t.Type<string, string>(
	'DeviceName',
	(i: unknown): i is string => ShortString.is(i) && i.indexOf('\n') === -1,
	(i, c) =>
		pipe(
			ShortString.validate(i, c),
			chain((s) =>
				s.indexOf('\n') === -1
					? t.success(s)
					: t.failure(s, c, 'must not contain newline chars'),
			),
		),
	t.identity,
);

export type DeviceName = t.TypeOf<typeof DeviceName>;

/**
 * Creates a record type that checks for constraints on the record elements
 */
const restrictedRecord = <
	K extends t.Mixed,
	V extends t.Mixed,
	R extends { [key in t.TypeOf<K>]: t.TypeOf<V> },
>(
	k: K,
	v: V,
	test: (i: R) => Either<string, R>,
	name = 'RestrictedRecord',
) => {
	return new t.Type<R>(
		name,
		(i): i is R => t.record(k, v).is(i) && isRight(test(i as R)),
		(i, c) =>
			pipe(
				// pipe takes the first result and passes it through rest of the function arguments
				t.record(k, v).validate(i, c), // validate that the element is a proper record first (returns an Either)
				chain(
					// chain takes a function (a) => Either and converts it into a function (Either) => (Either)
					flow(
						// flow creates a function composition
						test, // receives a record and returns Either<string,R>
						fold((m) => t.failure(i, c, m), t.success), // fold converts Either<string,R> to an Either<Errors, R>
					),
				),
			),
		t.identity,
	);
};

export const nonEmptyRecord = <K extends t.Mixed, V extends t.Mixed>(
	k: K,
	v: V,
) =>
	restrictedRecord(
		k,
		v,
		(o) =>
			Object.keys(o).length > 0
				? right(o)
				: left('must have at least 1 element'),
		'NonEmptyRecord',
	);
