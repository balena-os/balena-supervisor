import express from 'express';
import request from 'supertest';
import { expect } from 'chai';

import * as config from '~/src/config';
import * as testDb from '~/src/db';
import * as deviceApi from '~/src/device-api';
import * as middleware from '~/src/device-api/middleware';
import { AuthorizedRequest } from '~/src/device-api/api-keys';

describe('device-api/api-keys', () => {
	let app: express.Application;

	before(async () => {
		await config.initialized();
		app = express();
		app.use(middleware.auth);
		app.get('/test/:appId', (req: AuthorizedRequest, res) => {
			if (req.auth.isScoped({ apps: [parseInt(req.params.appId, 10)] })) {
				res.sendStatus(200);
			} else {
				res.sendStatus(401);
			}
		});
	});

	afterEach(async () => {
		// Delete all scoped API keys between calls to prevent leaking tests
		await testDb.models('apiSecret').whereNot({ appId: 0 }).del();
	});

	it('should generate a key which is scoped for a single application', async () => {
		const appOneKey = await deviceApi.generateScopedKey(111, 'one');
		const appTwoKey = await deviceApi.generateScopedKey(222, 'two');

		await request(app)
			.get('/test/111')
			.set('Authorization', `Bearer ${appOneKey}`)
			.expect(200);

		await request(app)
			.get('/test/222')
			.set('Authorization', `Bearer ${appTwoKey}`)
			.expect(200);

		await request(app)
			.get('/test/222')
			.set('Authorization', `Bearer ${appOneKey}`)
			.expect(401);

		await request(app)
			.get('/test/111')
			.set('Authorization', `Bearer ${appTwoKey}`)
			.expect(401);
	});

	it('should generate a key which is scoped for multiple applications', async () => {
		const multiAppKey = await deviceApi.generateScopedKey(111, 'three', {
			scopes: [111, 222].map((appId) => ({ type: 'app', appId })),
		});

		await request(app)
			.get('/test/111')
			.set('Authorization', `Bearer ${multiAppKey}`)
			.expect(200);

		await request(app)
			.get('/test/222')
			.set('Authorization', `Bearer ${multiAppKey}`)
			.expect(200);
	});

	it('should generate a key which is scoped for all applications', async () => {
		await request(app)
			.get('/test/111')
			.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
			.expect(200);

		await request(app)
			.get('/test/222')
			.set('Authorization', `Bearer ${await deviceApi.getGlobalApiKey()}`)
			.expect(200);
	});

	it('should have a cached lookup of key scopes', async () => {
		const globalScopes = await deviceApi.getScopesForKey(
			await deviceApi.getGlobalApiKey(),
		);

		const key = 'my-new-key';
		await testDb
			.models('apiSecret')
			.where({ key: await deviceApi.getGlobalApiKey() })
			.update({ key });

		// Key has been changed, but cache should retain the old key
		expect(
			await deviceApi.getScopesForKey(await deviceApi.getGlobalApiKey()),
		).to.deep.equal(globalScopes);

		// Bust the cache and generate a new global API key
		const refreshedKey = await deviceApi.refreshKey(
			await deviceApi.getGlobalApiKey(),
		);

		// Key that we changed in db is no longer valid
		expect(await deviceApi.getScopesForKey(key)).to.be.null;

		// Refreshed key should have the global scopes
		expect(await deviceApi.getScopesForKey(refreshedKey)).to.deep.equal(
			globalScopes,
		);
	});

	it('should regenerate a key and invalidate the old one', async () => {
		const appScopedKey = await deviceApi.generateScopedKey(111, 'four');

		await request(app)
			.get('/test/111')
			.set('Authorization', `Bearer ${appScopedKey}`)
			.expect(200);

		const newScopedKey = await deviceApi.refreshKey(appScopedKey);

		await request(app)
			.get('/test/111')
			.set('Authorization', `Bearer ${appScopedKey}`)
			.expect(401);

		await request(app)
			.get('/test/111')
			.set('Authorization', `Bearer ${newScopedKey}`)
			.expect(200);
	});
});
