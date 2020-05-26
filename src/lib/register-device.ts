import factory = require('balena-register-device');
import * as Bluebird from 'bluebird';
import { getRequestInstance } from './request';

export const { ApiError } = factory;

export const { generateUniqueKey, register } = factory({
	request: {
		send: Bluebird.method(async (options: {}) => {
			const request = await getRequestInstance();
			const [response] = await request.postAsync({ ...options, json: true });
			return response;
		}),
	},
});
