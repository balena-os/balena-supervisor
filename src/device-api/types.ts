import type { Request, Response, NextFunction } from 'express';

import type { ScopedResources, Scope } from './api-keys';

export type AuthorizedRequest = Request & {
	auth: {
		isScoped: (resources: Partial<ScopedResources>) => boolean;
		apiKey: string;
		scopes: Scope[];
	};
};

export type AuthorizedRequestHandler = (
	req: AuthorizedRequest,
	res: Response,
	next: NextFunction,
) => void;
