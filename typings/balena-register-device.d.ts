// Typings (incomplete) for balena-register-device@v6.0.1

// TODO: Upstream types to the repo
declare module 'balena-register-device' {
	import { Response } from 'request';
	import { TypedError } from 'typed-error';

	function factory({
		request,
	}): {
		generateUniqueKey: () => string;
		register: (opts: Dictionary<any>) => Bluebird<{ id: string }>;
	};

	factory.ApiError = class ApiError extends TypedError {
		public response: Response;
	};
	export = factory;
}
