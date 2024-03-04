import { getRegisterDevice } from 'balena-register-device';
export { ApiError } from 'balena-register-device';
import { getRequestInstance } from './request';

export const { generateUniqueKey, register } = getRegisterDevice({
	request: {
		send: async (options: object) => {
			const request = await getRequestInstance();
			const [response] = await request.postAsync({ ...options, json: true });
			return response;
		},
	},
});
