// Typings (incomplete) for balena-register-device@v6.0.1
// TODO: Upstream types to the repo
declare module 'balena-register-device' {
	function factory({
		request,
	}): {
		generateUniqueKey: () => string;
		register: (opts: Dictionary<any>) => Bluebird<{ id: string }>;
	};
	export = factory;
}
