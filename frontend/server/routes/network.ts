import express from 'express';

import * as network from '../lib/network';

const networkRouter = express.Router();

networkRouter.get('/', async (req, res) => {
	// Return latest run network checks
	try {
		const status = await network.getStatus();
		res.status(200).json(status);
	} catch (e) {
		console.error(e);
		// TODO better error handling
		res.status(500).send(e);
	}
});

networkRouter.post('/', async (req, res) => {
	// TODO: Re-run checks
});

export { networkRouter };
