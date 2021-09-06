import { getVPNStatus } from './supervisor-api';

// TODO: Setup network info cache

const runNetworkChecks = async () => {
	/* TODO - waiting on device diagnostics implementation */
};

export const getStatus = async () => {
	// const checkStatus = await runNetworkChecks();
	// TODO: Parse checkStatus, depends on device-diagnostics module changes

	return {
		// network (TODO determine sub-categories): parsed checkStatus,
		vpn: await getVPNStatus(),
	};
};
