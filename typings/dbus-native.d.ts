// Adapted from:
// https://gist.github.com/TianyiLi/a231afa2f804d8fa0805baa4830f9242
// tslint:disable
declare module 'dbus-native' {
	import * as net from 'net';
	import * as events from 'events';

	interface msg {
		destination?: string;
		path?: string;
		interface?: any;
		member: string;
		signature?: any;
		body?: Array<any>;
	}

	interface MessageBus {
		connection: any;
		serial: number;
		cookies: Object;
		methodCallHandlers: Object;
		signals: events.EventEmitter;
		exportedObjects: Object;

		invoke(msg: msg, callback?: Callback<any>): void;
		invokeDbus(msg: msg, callback?: Callback<any>): void;
		mangle(path: any, iface: any, member: any): string;
		mangle(obj: { path: any; iface: any; member: any }): string;
		sendSignal(
			path: any,
			iface: any,
			name: any,
			signature: any,
			args: any,
		): void;
		sendError(msg: any, signature: any, body: any): void;
		setMethodCallHandler(
			objectPath: any,
			iface: any,
			member: any,
			handler: any,
		): void;
		exportInterface(
			obj: Object,
			path: string,
			ifaceDesc: {
				name: string;
				signals: Object;
				method: Object;
				properties: Object;
			},
		): void;
		getService(serviceName: string): DBusService;
		getObject(path: string, name: string, callback: Callback<any>): DBusService;
		getInterface(
			path: string,
			objname: string,
			name: string,
			callback: Callback<any>,
		): DBusService;

		addMatch(match: string, callback?: Callback<any>): void;
		removeMatch(match: string, callback?: Callback<any>): void;
		getId(callback?: Callback<any>): void;
		requestName(name: string, flags: any, callback?: Callback<any>): void;
		releaseName(name: string, callback?: Callback<any>): void;
		listNames(callback?: Callback<any>): void;
		listActivatableNames(callback?: Callback<any>): void;
		updateActivationEnvironment(env: any, callback?: Callback<any>): void;
		startServiceByName(name: any, flags: any, callback?: Callback<any>): void;
		getConnectionUnixUser(name: any, callback?: Callback<any>): void;
		getConnectionUnixProcessId(name: any, callback?: Callback<any>): void;
		getNameOwner(name: any, callback?: Callback<any>): void;
		nameHasOwner(name: any, callback?: Callback<any>): void;
	}

	/**
	 * This Should Not Used
	 *
	 * TODO: Fix this
	 *
	 * @interface DBusService
	 */
	interface DBusService {
		name: string;
		bus: MessageBus;
		getObject(name: any, callback: Callback<any>): void;
		getInterface(
			objName: string,
			ifaceName: string,
			callback: Callback<any>,
		): void;
	}

	interface Server {
		server: net.Server;
		listen: void;
	}

	const messageType: {
		error: number;
		invalid: number;
		methodCall: number;
		methodReturn: number;
		signal: number;
	};

	enum flags {
		noReplyExpected = 1,
		noAutoStart,
	}

	interface StreamOptions {
		socket: string;
		host: any;
		port: any;
		busAddress: string;
	}

	class CreateConnection extends events.EventEmitter {
		message(msg: { path: string }): void;
		end(): void;
	}

	function createClient(options?: StreamOptions): MessageBus;
	function createConnection(opts?: StreamOptions): CreateConnection;
	/**
	 * Default is /var/run/dbus/system_bus_socket
	 *
	 * @export
	 * @returns {MessageBus}
	 */
	function systemBus(): MessageBus;
	function sessionBus(options?: StreamOptions): MessageBus;
	function createServer(): Server;
}
