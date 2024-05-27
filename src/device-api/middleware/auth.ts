import * as apiKeys from '../../lib/api-keys';
import * as config from '../../config';

import type { Request } from 'express';

/**
 * This middleware will extract an API key used to make a call, and then expand it out to provide
 * access to the scopes it has. The `req` will be updated to include this `auth` data.
 *
 * E.g. `req.auth.scopes: []`
 *
 * @param req
 * @param res
 * @param next
 */
export const auth: apiKeys.AuthorizedRequestHandler = async (
	req,
	res,
	next,
) => {
	// grab the API key used for the request
	const apiKey = getApiKeyFromRequest(req) ?? '';

	// store the key in the request, and an empty scopes array to populate after resolving the key scopes
	req.auth = {
		apiKey,
		scopes: [],
		isScoped: (resources) => apiKeys.isScoped(resources, req.auth.scopes),
	};

	try {
		const conf = await config.getMany(['localMode', 'unmanaged']);

		// we only need to check the API key if managed and not in local mode
		const needsAuth = !conf.unmanaged && !conf.localMode;

		// no need to authenticate, shortcut
		if (!needsAuth) {
			// Allow requests that do not need auth to be scoped for all applications
			req.auth.isScoped = () => true;
			return next();
		}

		// if we have a key, find the scopes and add them to the request
		if (apiKey && apiKey !== '') {
			await apiKeys.initialized();
			const scopes = await apiKeys.getScopesForKey(apiKey);

			if (scopes != null) {
				// keep the scopes for later incase they're desired
				req.auth.scopes.push(...scopes);
				return next();
			}
		}

		// we do not have a valid key...
		return res.sendStatus(401);
	} catch (err) {
		console.error(err);
		res.status(503).send(`Unexpected error: ${err}`);
	}
};

function getApiKeyFromRequest(req: Request): string | undefined {
	const { apikey } = req.query;
	// Check query for key
	if (apikey && typeof apikey === 'string') {
		return apikey;
	}

	// Get Authorization header to search for key
	const authHeader = req.get('Authorization');

	// Check header for key
	if (!authHeader) {
		return undefined;
	}

	// Check authHeader with various schemes
	const match = authHeader.match(/^(?:ApiKey|Bearer) (\w+)$/i);

	// Return key from match or undefined
	return match?.[1];
}
