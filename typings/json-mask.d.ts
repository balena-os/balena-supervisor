declare module 'json-mask' {
	function mask(obj: Dictionary<any>, mask: string): Dictionary<any>;

	// These types are not strictly correct, but they don't need to be for our usage
	namespace mask {
		export const compile: (mask: string) => any;
		export const filter: (obj: Dictionary<any>, compiledMask: any) => any;
	}

	export = mask;
}
