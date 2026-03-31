import nock from 'nock';

import * as config from '~/src/config';
import * as tags from '~/src/api-binder/tags';
import { expect } from 'chai';
import { waitFor } from '~/test-lib/helper';
import { setTimeout } from 'timers/promises';
import SupervisorAPI from '~/src/device-api';
import * as v2 from '~/src/device-api/v2';
import type { Application } from 'express';
import request from 'supertest';
import * as apiKeys from '~/lib/api-keys';

describe('device-tags', () => {
	let apiEndpoint: string;
	let uuid: string;
	before(async () => {
		await config.initialized();
		await tags.initialized();
		apiEndpoint = await config.get('apiEndpoint');
		const $uuid = await config.get('uuid');

		if ($uuid == null) {
			throw new Error('Device uuid is required for tags tests');
		}
		uuid = $uuid;
	});

	describe('Setting tags internally', () => {
		it('accepts multiple tags and attempts to update balena-api', async function () {
			let tagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					tagsPatchBody = requestBody;
					return {};
				});
			await tags.setTags({
				a: '1',
				b: '2',
			});
			await waitFor({
				checkFn: () => tagsPatchBody !== undefined,
			});

			expect(tagsPatchBody).to.deep.equal({
				[uuid]: {
					a: '1',
					b: '2',
				},
			});
		});

		it('batches multiple requests in quick succession', async function () {
			let tagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					tagsPatchBody = requestBody;
					return {};
				});
			await tags.setTags({
				c: '3',
			});
			await waitFor({
				checkFn: () => tagsPatchBody !== undefined,
			});

			expect(tagsPatchBody).to.deep.equal({
				[uuid]: {
					c: '3',
				},
			});

			let batchedTagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					batchedTagsPatchBody = requestBody;
					return {};
				});
			await tags.setTags({
				d: '4',
			});
			await setTimeout(10);
			await tags.setTags({
				e: '5',
			});
			await setTimeout(10);
			await tags.setTags({
				f: '6',
			});
			await waitFor({
				checkFn: () => batchedTagsPatchBody !== undefined,
				// Increase the max count slightly as we intentionally trigger a full delay
				maxCount: 250,
			});

			expect(batchedTagsPatchBody).to.deep.equal({
				[uuid]: {
					d: '4',
					e: '5',
					f: '6',
				},
			});
		});

		it('should not report unchanged tags', async function () {
			let tagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					tagsPatchBody = requestBody;
					return {};
				});
			await tags.setTags({
				a: '1',
				b: '2',
				c: '3',
				d: '4',
				e: '5',
				f: '6',
				g: '7',
			});
			await waitFor({
				checkFn: () => tagsPatchBody !== undefined,
			});

			expect(tagsPatchBody).to.deep.equal({
				[uuid]: {
					g: '7',
				},
			});
		});

		it('should report changed tags that were previously reported', async function () {
			let tagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					tagsPatchBody = requestBody;
					return {};
				});
			await tags.setTags({
				a: '11',
				b: '2',
				c: '3',
				d: '4',
				e: '55',
				f: '6',
				g: '7',
			});
			await waitFor({
				checkFn: () => tagsPatchBody !== undefined,
			});

			expect(tagsPatchBody).to.deep.equal({
				[uuid]: {
					a: '11',
					e: '55',
				},
			});
		});
	});

	describe('Setting tags via API', () => {
		let api: Application;

		const apiSetTags = async (body: Record<string, string>) =>
			await request(api)
				.patch('/v2/device/tags')
				.send(body)
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(202, {
					status: 'success',
				});

		before(() => {
			// `api` is a private property on SupervisorAPI but
			// passing it directly to supertest is easier than
			// setting up an API listen port & timeout
			api = new SupervisorAPI({
				routers: [v2.router],
				healthchecks: [],
				// @ts-expect-error extract private variable for testing
			}).api;
		});
		it('accepts multiple tags and attempts to update balena-api', async function () {
			let tagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					tagsPatchBody = requestBody;
					return {};
				});
			await apiSetTags({
				z: '1',
				y: '2',
			});
			await waitFor({
				checkFn: () => tagsPatchBody !== undefined,
			});

			expect(tagsPatchBody).to.deep.equal({
				[uuid]: {
					z: '1',
					y: '2',
				},
			});
		});

		it('batches multiple requests in quick succession', async function () {
			let tagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					tagsPatchBody = requestBody;
					return {};
				});
			await apiSetTags({
				x: '3',
			});
			await waitFor({
				checkFn: () => tagsPatchBody !== undefined,
			});

			expect(tagsPatchBody).to.deep.equal({
				[uuid]: {
					x: '3',
				},
			});

			let batchedTagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					batchedTagsPatchBody = requestBody;
					return {};
				});
			await apiSetTags({
				w: '4',
			});
			await setTimeout(10);
			await apiSetTags({
				v: '5',
			});
			await setTimeout(10);
			await apiSetTags({
				u: '6',
			});
			await waitFor({
				checkFn: () => batchedTagsPatchBody !== undefined,
				// Increase the max count slightly as we intentionally trigger a full delay
				maxCount: 250,
			});

			expect(batchedTagsPatchBody).to.deep.equal({
				[uuid]: {
					w: '4',
					v: '5',
					u: '6',
				},
			});
		});

		it('should not report unchanged tags', async function () {
			let tagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					tagsPatchBody = requestBody;
					return {};
				});
			await apiSetTags({
				z: '1',
				y: '2',
				x: '3',
				w: '4',
				v: '5',
				u: '6',
				t: '7',
			});
			await waitFor({
				checkFn: () => tagsPatchBody !== undefined,
			});

			expect(tagsPatchBody).to.deep.equal({
				[uuid]: {
					t: '7',
				},
			});
		});

		it('should report changed tags that were previously reported', async function () {
			let tagsPatchBody: nock.Body | undefined;
			nock(apiEndpoint)
				.patch('/device/v3/tags')
				.once()
				.reply(200, (_uri, requestBody) => {
					tagsPatchBody = requestBody;
					return {};
				});
			await apiSetTags({
				z: '11',
				y: '2',
				x: '3',
				w: '4',
				v: '55',
				u: '6',
				t: '7',
			});
			await waitFor({
				checkFn: () => tagsPatchBody !== undefined,
			});

			expect(tagsPatchBody).to.deep.equal({
				[uuid]: {
					z: '11',
					v: '55',
				},
			});
		});

		it('should reject invalid tag keys', async function () {
			await request(api)
				.patch('/v2/device/tags')
				.send({
					'invalid key': '1',
				})
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400, {
					status: 'failed',
					message: 'Tag keys cannot contain whitespace',
				});
		});

		it('should reject invalid tag values', async function () {
			await request(api)
				.patch('/v2/device/tags')
				.send({
					tagKey: 123,
				})
				.set('Authorization', `Bearer ${await apiKeys.getGlobalApiKey()}`)
				.expect(400, {
					status: 'failed',
					message:
						'Invalid tags body, must be an object like `{[tagKey: string]: string}`',
				});
		});
	});
});
