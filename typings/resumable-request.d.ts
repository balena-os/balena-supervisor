declare module 'resumable-request' {
	import * as request from 'request';
	// Not technically correct, but they do share an interface
	export = request;
}
