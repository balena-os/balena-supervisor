import * as https from 'https';
import * as stream from 'stream';
import * as zlib from 'zlib';
import * as Promise from 'bluebird';
import { expect } from 'chai';
import * as sinon from 'sinon';

import * as config from '~/src/config';

describe('Logger', function () {
	let logger: typeof import('~/src/logger');
	let configStub: sinon.SinonStub;

	beforeEach(async function () {
		this._req = new stream.PassThrough();
		this._req.flushHeaders = sinon.spy();
		this._req.end = sinon.spy();

		this._req.body = '';
		this._req.pipe(zlib.createGunzip()).on('data', (chunk: Buffer) => {
			this._req.body += chunk;
		});

		this.requestStub = sinon.stub(https, 'request').returns(this._req);

		configStub = sinon.stub(config, 'getMany').returns(
			// @ts-expect-error this should actually work but the type system doesnt like it
			Promise.resolve({
				apiEndpoint: 'https://example.com',
				uuid: 'deadbeef',
				deviceApiKey: 'secretkey',
				unmanaged: false,
				loggingEnabled: true,
				localMode: false,
			}),
		);
		// delete the require cache for the logger module so we can force a refresh
		delete require.cache[require.resolve('~/src/logger')];
		logger = require('~/src/logger');
		await logger.initialized();
	});

	afterEach(function () {
		this.requestStub.restore();
		configStub.restore();
	});

	after(function () {
		delete require.cache[require.resolve('~/src/logger')];
	});

	it('waits the grace period before sending any logs', function () {
		const clock = sinon.useFakeTimers();
		logger.log({ message: 'foobar', serviceId: 15 });
		clock.tick(4999);
		clock.restore();

		return Promise.delay(100).then(() => {
			expect(this._req.body).to.equal('');
		});
	});

	it('tears down the connection after inactivity', function () {
		const clock = sinon.useFakeTimers();
		logger.log({ message: 'foobar', serviceId: 15 });
		clock.tick(61000);
		clock.restore();

		return Promise.delay(100).then(() => {
			expect(this._req.end.calledOnce).to.be.true;
		});
	});

	it('sends logs as gzipped ndjson', function () {
		const timestamp = Date.now();
		logger.log({ message: 'foobar', serviceId: 15 });
		logger.log({ timestamp: 1337, message: 'foobar', serviceId: 15 });
		logger.log({ message: 'foobar' }); // shold be ignored

		return Promise.delay(5500).then(() => {
			expect(this.requestStub.calledOnce).to.be.true;
			const opts = this.requestStub.firstCall.args[0];

			expect(opts.href).to.equal(
				'https://example.com/device/v2/deadbeef/log-stream',
			);
			expect(opts.method).to.equal('POST');
			expect(opts.headers).to.deep.equal({
				Authorization: 'Bearer secretkey',
				'Content-Type': 'application/x-ndjson',
				'Content-Encoding': 'gzip',
			});

			const lines = this._req.body.split('\n');
			expect(lines.length).to.equal(3);
			expect(lines[2]).to.equal('');

			let msg = JSON.parse(lines[0]);
			expect(msg).to.have.property('message').that.equals('foobar');
			expect(msg).to.have.property('serviceId').that.equals(15);
			expect(msg).to.have.property('timestamp').that.is.at.least(timestamp);
			msg = JSON.parse(lines[1]);
			expect(msg).to.deep.equal({
				timestamp: 1337,
				message: 'foobar',
				serviceId: 15,
			});
		});
	});

	it('allows logging system messages which are also reported to the eventTracker', function () {
		const timestamp = Date.now();
		logger.logSystemMessage(
			'Hello there!',
			{ someProp: 'someVal' },
			'Some event name',
		);

		return Promise.delay(5500).then(() => {
			const lines = this._req.body.split('\n');
			expect(lines.length).to.equal(2);
			expect(lines[1]).to.equal('');

			const msg = JSON.parse(lines[0]);
			expect(msg).to.have.property('message').that.equals('Hello there!');
			expect(msg).to.have.property('isSystem').that.equals(true);
			expect(msg).to.have.property('timestamp').that.is.at.least(timestamp);
		});
	});
});
