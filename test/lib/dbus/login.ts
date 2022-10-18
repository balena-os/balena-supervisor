import { createSystemInterface } from './utils';

// Create login interface
const login = createSystemInterface(
	'org.freedesktop.login1',
	'/org/freedesktop/login1',
	'org.freedesktop.login1.Manager',
);

type SystemState = { status: 'ready' | 'rebooting' | 'off' };
const systemState: SystemState = { status: 'ready' };
login.addMethod(
	'Reboot',
	{ in: [{ type: 'b', name: 'interactive' }] } as any,
	function (_interactive, callback) {
		// Wait a bit before changing the runtime state
		setTimeout(() => {
			console.log('Rebooting');
			systemState.status = 'rebooting';
		}, 500);

		callback(null);
	},
);

login.addMethod(
	'PowerOff',
	{ in: [{ type: 'b', name: 'interactive' }] } as any,
	function (_interactive, callback) {
		// Wait a bit before changing the runtime state
		setTimeout(() => {
			console.log('Powering off');
			systemState.status = 'off';
		}, 500);

		callback(null);
	},
);

// This is not a real login interface method, but it will help for
// testing
login.addMethod(
	'PowerOn',
	{ in: [{ type: 'b', name: 'interactive' }] } as any,
	function (_interactive, callback) {
		// Wait a bit before changing the runtime state
		setTimeout(() => {
			console.log('Starting up');
			systemState.status = 'ready';
		}, 500);

		callback(null);
	},
);

// This is not a real login interface method, but it will help for
// testing
login.addMethod(
	'GetState',
	{ out: { type: 's', name: 'state' } } as any,
	function (callback: any) {
		callback(null, systemState.status);
	},
);

login.update();
