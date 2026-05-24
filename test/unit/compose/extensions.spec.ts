import { expect } from 'chai';
import * as sinon from 'sinon';

import {
	compareExtensions,
	digestOf,
	containerNameFor,
	volumeNameFor,
	isOverlayService,
	isDataStore,
	isMountBusyError,
	getDeployedExtensions,
} from '~/src/compose/extensions';
import type { ExtensionState } from '~/src/compose/extensions';
import type { ServiceComposeConfig } from '~/src/compose/types/service';
import { docker } from '~/lib/docker-utils';

describe('compose/extensions', () => {
	const REG = 'registry2.balena.io/v2/abc';
	const DIGEST_A =
		'sha256:aaaaaaaaaaaa1111111111112222222222223333333333334444555566667777';
	const IMG_A = `${REG}@${DIGEST_A}`;
	const DIGEST_B =
		'sha256:bbbbbbbbbbbb5555555555556666666666667777777777778888999900001111';
	const IMG_B = `${REG}@${DIGEST_B}`;

	describe('isOverlayService', () => {
		it('returns true for services with io.balena.image.class=overlay', () => {
			const svc = {
				image: 'test:latest',
				labels: { 'io.balena.image.class': 'overlay' },
			} as ServiceComposeConfig;
			expect(isOverlayService(svc)).to.be.true;
		});

		it('returns false for services with a different class', () => {
			const svc = {
				image: 'test:latest',
				labels: { 'io.balena.image.class': 'service' },
			} as ServiceComposeConfig;
			expect(isOverlayService(svc)).to.be.false;
		});

		it('returns false for services without a class label', () => {
			const svc = {
				image: 'test:latest',
				labels: {},
			} as ServiceComposeConfig;
			expect(isOverlayService(svc)).to.be.false;
		});

		it('returns false for services without labels', () => {
			const svc = { image: 'test:latest' } as ServiceComposeConfig;
			expect(isOverlayService(svc)).to.be.false;
		});
	});

	describe('isDataStore', () => {
		it('returns true for services with io.balena.image.store=data', () => {
			const svc = {
				image: 'test:latest',
				labels: { 'io.balena.image.store': 'data' },
			} as ServiceComposeConfig;
			expect(isDataStore(svc)).to.be.true;
		});

		it('returns true for services without a store label (default)', () => {
			const svc = {
				image: 'test:latest',
				labels: {},
			} as ServiceComposeConfig;
			expect(isDataStore(svc)).to.be.true;
		});

		it('returns false for services with store=root', () => {
			const svc = {
				image: 'test:latest',
				labels: { 'io.balena.image.store': 'root' },
			} as ServiceComposeConfig;
			expect(isDataStore(svc)).to.be.false;
		});
	});

	describe('digestOf', () => {
		it('returns the sha256 digest from a digest-pinned reference', () => {
			expect(digestOf(IMG_A)).to.equal(DIGEST_A);
		});

		it('throws on a digest-less reference', () => {
			expect(() => digestOf('registry2.balena.io/v2/abc:latest')).to.throw(
				/digest-pinned/,
			);
		});
	});

	describe('containerNameFor', () => {
		it('derives a stable name from the short digest', () => {
			expect(containerNameFor('kernel-modules', IMG_A)).to.equal(
				'ext_kernel-modules_aaaaaaaaaaaa',
			);
		});

		it('throws on a digest-less reference', () => {
			expect(() => containerNameFor('svc', 'registry/img:latest')).to.throw(
				/digest-pinned/,
			);
		});
	});

	describe('volumeNameFor', () => {
		it('derives a descriptive volume name from the short digest and dest', () => {
			expect(volumeNameFor('kernel-modules', IMG_A, '/boot')).to.equal(
				'ext_kernel-modules_aaaaaaaaaaaa_boot',
			);
		});

		it('sanitizes nested destinations', () => {
			expect(volumeNameFor('svc', IMG_A, '/lib/modules')).to.equal(
				'ext_svc_aaaaaaaaaaaa_lib_modules',
			);
		});
	});

	describe('isMountBusyError', () => {
		it('returns true for a 500 with a busy message', () => {
			expect(
				isMountBusyError({
					statusCode: 500,
					message: 'failed to remove root filesystem: device or resource busy',
				}),
			).to.be.true;
		});

		it('returns true for an EBUSY message', () => {
			expect(isMountBusyError({ statusCode: 500, message: 'EBUSY' })).to.be
				.true;
		});

		it('returns false for a 404', () => {
			expect(isMountBusyError({ statusCode: 404, message: 'busy' })).to.be
				.false;
		});

		it('returns false for a 500 without a busy keyword', () => {
			expect(isMountBusyError({ statusCode: 500, message: 'unknown error' })).to
				.be.false;
		});

		it('returns false for an error with no statusCode', () => {
			expect(isMountBusyError(new Error('device or resource busy'))).to.be
				.false;
		});
	});

	describe('compareExtensions', () => {
		const overlay = (
			serviceName: string,
			image: string,
		): ServiceComposeConfig =>
			({
				serviceName,
				image,
				labels: { 'io.balena.image.class': 'overlay' },
			}) as ServiceComposeConfig;

		const deployed = (serviceName: string, image: string): ExtensionState => ({
			serviceName,
			image,
			containerId: `${serviceName}-${digestOf(image).slice(7, 19)}`,
			createdAt: new Date('2026-05-24T10:05:00Z'),
			labels: { 'io.balena.image.class': 'overlay' },
		});

		it('deploys a new overlay (no current entry)', () => {
			const res = compareExtensions([], [overlay('kmods', IMG_A)]);
			expect(res.toDeploy.map((s) => s.serviceName)).to.deep.equal(['kmods']);
			expect(res.toDrop).to.be.empty;
		});

		it('is a no-op when (serviceName, digest) already matches', () => {
			const res = compareExtensions(
				[deployed('kmods', IMG_A)],
				[overlay('kmods', IMG_A)],
			);
			expect(res.toDeploy).to.be.empty;
			expect(res.toDrop).to.be.empty;
		});

		it('supersedes: same service, different digest → deploy new, keep old', () => {
			// The old, active overlay is kept (its mount is in use until
			// reboot); only the new digest is deployed.
			const old = deployed('kmods', IMG_A);
			const res = compareExtensions([old], [overlay('kmods', IMG_B)]);
			expect(res.toDeploy.map((s) => s.image)).to.deep.equal([IMG_B]);
			expect(res.toDrop).to.be.empty;
		});

		it('does not throw when a deployed container carries a non-digest image ref', () => {
			// Config.Image can degrade to a bare image id (`sha256:<id>`), which
			// has no `@digest`. Identity comparison must degrade to a non-match
			// (re-evaluate the overlay), never throw — mirroring images.isSameImage.
			const bareId: ExtensionState = {
				serviceName: 'kmods',
				image:
					'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
				containerId: 'kmods-bare',
				createdAt: new Date('2026-05-24T10:05:00Z'),
				labels: { 'io.balena.image.class': 'overlay' },
			};
			const res = compareExtensions([bareId], [overlay('kmods', IMG_A)]);
			expect(res.toDeploy.map((s) => s.serviceName)).to.deep.equal(['kmods']);
			expect(res.toDrop).to.be.empty;
		});

		it('drops: service absent from target → remove only', () => {
			const old = deployed('kmods', IMG_A);
			const res = compareExtensions([old], []);
			expect(res.toDeploy).to.be.empty;
			expect(res.toDrop).to.deep.equal([old]);
		});

		it('handles a mix of deploy, supersede (kept) and drop', () => {
			const supersededRow = deployed('kmods', IMG_A);
			const droppedRow = deployed('firmware', IMG_A);
			const res = compareExtensions(
				[supersededRow, droppedRow],
				[overlay('kmods', IMG_B), overlay('audio', IMG_A)],
			);
			expect(res.toDeploy.map((s) => s.serviceName).sort()).to.deep.equal([
				'audio',
				'kmods',
			]);
			// kmods is superseded → kept (not removed); only firmware is dropped.
			expect(res.toDrop).to.deep.equal([droppedRow]);
		});
	});

	describe('getDeployedExtensions', () => {
		afterEach(() => {
			sinon.restore();
		});

		// Build a fake inspect result for a good (exited-0) overlay container.
		const goodInspect = (id: string, serviceName: string, image: string) => ({
			Id: id,
			Created: '2026-05-24T10:05:00Z',
			Config: {
				Image: image,
				Labels: {
					'io.balena.image.class': 'overlay',
					'io.balena.service-name': serviceName,
				},
			},
			State: { Status: 'exited', ExitCode: 0, Error: '' },
		});

		const inspectErr = (statusCode: number, message: string) => {
			const err: any = new Error(message);
			err.statusCode = statusCode;
			return err;
		};

		// Stub the engine so `failId` rejects on inspect (as if reaped/transient)
		// while `good` inspects to a deployed overlay.
		const stubEngine = (failId: string, err: Error) => {
			sinon
				.stub(docker, 'listContainers')
				.resolves([{ Id: failId }, { Id: 'good' }] as any);
			sinon.stub(docker, 'getContainer').callsFake(
				(id: string) =>
					({
						inspect: () =>
							id === failId
								? Promise.reject(err)
								: Promise.resolve(goodInspect('good', 'kmods', IMG_A)),
					}) as any,
			);
		};

		it('skips a container that disappears between list and inspect', async () => {
			// The OS reaper independently removes overlay containers. A container
			// reaped after listContainers but before inspect must be treated as
			// absent, not crash the whole reconciliation.
			stubEngine('reaped', inspectErr(404, 'no such container'));

			const deployed = await getDeployedExtensions();

			expect(deployed.map((d) => d.serviceName)).to.deep.equal(['kmods']);
		});

		it('skips a container whose inspect fails with a transient engine error', async () => {
			stubEngine('flaky', inspectErr(500, 'connection reset'));

			const deployed = await getDeployedExtensions();

			expect(deployed.map((d) => d.serviceName)).to.deep.equal(['kmods']);
		});

		it('does not fall back to the listContainers image id when Config.Image is absent', async () => {
			// summary.Image from listContainers is a bare image id, not a pinned
			// ref; substituting it (as the old `?? summary.Image` did) injected a
			// digest-less value into identity comparison. App reconciliation reads
			// Config.Image only — match that.
			sinon
				.stub(docker, 'listContainers')
				.resolves([{ Id: 'good', Image: 'sha256:bareimageid' }] as any);
			sinon.stub(docker, 'getContainer').returns({
				inspect: () =>
					Promise.resolve({
						Id: 'good',
						Created: '2026-05-24T10:05:00Z',
						Config: {
							Labels: {
								'io.balena.image.class': 'overlay',
								'io.balena.service-name': 'kmods',
							},
						},
						State: { Status: 'exited', ExitCode: 0, Error: '' },
					}),
			} as any);

			const deployed = await getDeployedExtensions();

			expect(deployed).to.have.length(1);
			expect(deployed[0].image).to.equal('');
		});
	});
});
