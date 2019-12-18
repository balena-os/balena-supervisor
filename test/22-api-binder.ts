import { expect } from 'chai';
import { APIBinder, APIBinderConstructOpts } from '../src/api-binder';
import { DeviceStatus } from '../src/types/state';

describe('APIBinder', () => {
	let apiBinder: APIBinder;

	before(() => {
		apiBinder = new APIBinder({} as APIBinderConstructOpts);
	});

	describe('stripDeviceStateInLocalMode', () => {
		const sampleState = {
			local: {
				ip_address: '192.168.1.42 192.168.1.99',
				api_port: 48484,
				api_secret:
					'20ffbd6e15aba827dca6381912d6aeb6c3a7a7c7206d4dfadf0d2f0a9e1136',
				os_version: 'balenaOS 2.32.0+rev4',
				os_variant: 'dev',
				supervisor_version: '9.16.3',
				provisioning_progress: null,
				provisioning_state: '',
				status: 'Idle',
				logs_channel: null,
				apps: {},
				is_on__commit: 'whatever',
			},
			dependent: { apps: {} },
		} as DeviceStatus;

		it('should strip applications data', () => {
			const result = apiBinder.stripDeviceStateInLocalMode(
				sampleState,
			) as Dictionary<any>;
			expect(result).to.not.have.property('dependent');

			const local = result['local'];
			expect(local).to.not.have.property('apps');
			expect(local).to.not.have.property('is_on__commit');
			expect(local).to.not.have.property('logs_channel');
		});
	});
});
