import { TypedError } from 'typed-error';

export default class ShortStackError extends TypedError {
	constructor(err: Error | string = '') {
		Error.stackTraceLimit = 1;
		super(err);
	}
}
