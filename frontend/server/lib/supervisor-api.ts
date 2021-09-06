import axios from 'axios';

import { SV_ADDR } from './constants';
import { getGlobalApiKey } from './supervisor-db';

// Set up Axios request instance for Supervisor API
const svRequest = axios.create({
	baseURL: SV_ADDR,
	timeout: 1000,
});

// Add Supervisor global API key to request header
svRequest.interceptors.request.use(
	async (config) => {
		const apiKey = await getGlobalApiKey();
		config.headers.Authorization = `Bearer ${apiKey}`;
		return config;
	},
	async (err) => {
		// TODO
		return Promise.reject(err);
	},
);

// https://www.balena.io/docs/reference/supervisor/supervisor-api/#device-vpn-information
export const getVPNStatus = async () => {
	try {
		const { data } = await svRequest.get('/v2/device/vpn');
		return data.vpn;
	} catch (e) {
		// TODO: Better type-safe error handling - neverthrow package?
		console.error(e);
		throw e;
	}
};
