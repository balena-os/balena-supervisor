import { expect } from 'chai';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import {
	filterByActiveProfiles,
	compareExtensions,
	extractDigest,
	imageKey,
	containerNameFor,
	isOverlayService,
	isDataStore,
	deployExtensionContainer,
	ensureExtensionImage,
	ensureExtensionContainer,
	removeExtensionContainer,
	removeDroppedExtensions,
	getDeployedExtensions,
	type ExtensionState,
} from '~/src/compose/extensions';
import type { ServiceComposeConfig } from '~/src/compose/types/service';
import * as dockerUtils from '~/src/lib/docker-utils';
import * as config from '~/src/config';
import * as reboot from '~/src/lib/reboot';

const DIGEST_A = 'sha256:aaaaaaaaaaaa1111111111112222222222223333333333334444';
const DIGEST_B = 'sha256:bbbbbbbbbbbb5555555555556666666666667777777777778888';

const overlayService = (
	svc: Partial<ServiceComposeConfig> & { serviceName: string; image: string },
): ServiceComposeConfig =>
	({
		...svc,
		labels: {
			'io.balena.image.class': 'overlay',
			...(svc.labels ?? {}),
		},
	}) as ServiceComposeConfig;

const row = (
	overrides: Partial<ExtensionState> & { serviceName: string; image: string },
): ExtensionState => ({
	containerId: `${overrides.serviceName}-${imageKey(overrides.image).slice(7, 19)}`,
	...overrides,
});

describe('compose/extensions', () => {
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

	describe('filterByActiveProfiles', () => {
		it('includes services without profiles (backward compatible)', () => {
			const services: ServiceComposeConfig[] = [
				{ serviceName: 'svc1', image: 'img1:latest' } as ServiceComposeConfig,
				{ serviceName: 'svc2', image: 'img2:latest' } as ServiceComposeConfig,
			];
			expect(filterByActiveProfiles(services, new Set())).to.have.lengthOf(2);
		});

		it('includes services with an empty profiles array', () => {
			const services: ServiceComposeConfig[] = [
				{
					serviceName: 'svc1',
					image: 'img1:latest',
					profiles: [],
				} as ServiceComposeConfig,
			];
			expect(filterByActiveProfiles(services, new Set())).to.have.lengthOf(1);
		});

		it('includes services with matching profiles', () => {
			const services: ServiceComposeConfig[] = [
				{
					serviceName: 'kernel-modules',
					image: 'img1:latest',
					profiles: ['kernel-modules'],
				} as ServiceComposeConfig,
				{
					serviceName: 'wifi-firmware',
					image: 'img2:latest',
					profiles: ['wifi'],
				} as ServiceComposeConfig,
			];
			const result = filterByActiveProfiles(
				services,
				new Set(['kernel-modules']),
			);
			expect(result).to.have.lengthOf(1);
			expect(result[0].serviceName).to.equal('kernel-modules');
		});

		it('includes services with any matching profile', () => {
			const services: ServiceComposeConfig[] = [
				{
					serviceName: 'multi-profile',
					image: 'img1:latest',
					profiles: ['profile-a', 'profile-b'],
				} as ServiceComposeConfig,
			];
			expect(
				filterByActiveProfiles(services, new Set(['profile-b'])),
			).to.have.lengthOf(1);
		});

		it('excludes services with non-matching profiles', () => {
			const services: ServiceComposeConfig[] = [
				{
					serviceName: 'svc1',
					image: 'img1:latest',
					profiles: ['inactive-profile'],
				} as ServiceComposeConfig,
			];
			expect(
				filterByActiveProfiles(services, new Set(['active-profile'])),
			).to.have.lengthOf(0);
		});
	});

	describe('extractDigest', () => {
		it('extracts sha256 digest from registry reference', () => {
			expect(
				extractDigest(
					'registry2.balena-staging.com/v2/abc@sha256:15ba8034fbffcd3f',
				),
			).to.equal('sha256:15ba8034fbffcd3f');
		});

		it('returns undefined for references without a digest', () => {
			expect(extractDigest('registry/image:v1')).to.be.undefined;
			expect(extractDigest('local-tag:latest')).to.be.undefined;
		});

		it('returns undefined for an empty string', () => {
			expect(extractDigest('')).to.be.undefined;
		});
	});

	describe('imageKey', () => {
		it('returns the sha256 digest when present', () => {
			expect(imageKey(`registry/foo@${DIGEST_A}`)).to.equal(DIGEST_A);
		});

		it('treats references sharing a digest as identical', () => {
			expect(imageKey(`a/foo@${DIGEST_A}`)).to.equal(
				imageKey(`b/bar@${DIGEST_A}`),
			);
		});

		it('returns a deterministic synthetic digest when no sha256 is present', () => {
			const k = imageKey('registry/image:v1');
			expect(k.startsWith('sha256:')).to.be.true;
			expect(imageKey('registry/image:v1')).to.equal(k);
			expect(imageKey('registry/image:v2')).to.not.equal(k);
		});
	});

	describe('containerNameFor', () => {
		it('includes the service name and short digest', () => {
			const name = containerNameFor(
				'kernel-modules',
				`registry/km@${DIGEST_A}`,
			);
			expect(name).to.equal(`ext_kernel-modules_${DIGEST_A.slice(7, 19)}`);
		});

		it('produces distinct names for different digests of the same service', () => {
			const a = containerNameFor('kernel-modules', `registry/km@${DIGEST_A}`);
			const b = containerNameFor('kernel-modules', `registry/km@${DIGEST_B}`);
			expect(a).to.not.equal(b);
		});
	});

	describe('getDeployedExtensions', () => {
		let listContainersStub: SinonStub;

		beforeEach(() => {
			listContainersStub = stub(dockerUtils.docker, 'listContainers');
		});
		afterEach(() => {
			listContainersStub.restore();
		});

		it('returns an empty list when the engine has no overlay containers', async () => {
			listContainersStub.resolves([]);
			expect(await getDeployedExtensions()).to.deep.equal([]);
		});

		it('parses serviceName from the canonical container name', async () => {
			const image = `registry/km@${DIGEST_A}`;
			const shortD = DIGEST_A.slice(7, 19);
			listContainersStub.resolves([
				{
					Id: 'cid-1',
					Names: [`/ext_kernel-modules-raspberrypi4-64_${shortD}`],
					Image: image,
					Labels: { 'io.balena.image.class': 'overlay' },
				},
			]);

			const result = await getDeployedExtensions();
			expect(result).to.deep.equal([
				{
					serviceName: 'kernel-modules-raspberrypi4-64',
					image,
					containerId: 'cid-1',
				},
			]);
		});

		it('handles multiple containers for the same service (different digests)', async () => {
			const imageA = `registry/km@${DIGEST_A}`;
			const imageB = `registry/km@${DIGEST_B}`;
			listContainersStub.resolves([
				{
					Id: 'cid-a',
					Names: [`/ext_km_${DIGEST_A.slice(7, 19)}`],
					Image: imageA,
					Labels: { 'io.balena.image.class': 'overlay' },
				},
				{
					Id: 'cid-b',
					Names: [`/ext_km_${DIGEST_B.slice(7, 19)}`],
					Image: imageB,
					Labels: { 'io.balena.image.class': 'overlay' },
				},
			]);

			const result = await getDeployedExtensions();
			expect(result).to.have.lengthOf(2);
			expect(result.map((r) => r.serviceName)).to.deep.equal(['km', 'km']);
			expect(result.map((r) => r.containerId)).to.deep.equal([
				'cid-a',
				'cid-b',
			]);
		});

		it('skips containers whose name does not match the canonical pattern', async () => {
			// A manually-named container or one created by a non-supervisor
			// pipeline — we don't manage it.
			listContainersStub.resolves([
				{
					Id: 'cid-manual',
					Names: ['/manual-name'],
					Image: 'local/foo:latest',
					Labels: { 'io.balena.image.class': 'overlay' },
				},
			]);

			expect(await getDeployedExtensions()).to.deep.equal([]);
		});
	});

	describe('compareExtensions', () => {
		it('emits toPull and toDeploy for a target overlay not yet tracked (profile active)', () => {
			const target = [
				overlayService({
					serviceName: 'kernel-modules',
					image: `registry/km@${DIGEST_A}`,
				}),
			];

			const result = compareExtensions([], target);

			expect(result.toPull).to.have.lengthOf(1);
			expect(result.toDeploy).to.have.lengthOf(1);
			expect(result.toRemove).to.be.empty;
		});

		it('emits toPull but NOT toDeploy for a profile-off overlay', () => {
			const target = [
				overlayService({
					serviceName: 'kernel-modules',
					image: `registry/km@${DIGEST_A}`,
					profiles: ['kernel-modules'],
				}),
			];

			const result = compareExtensions([], target, new Set());

			expect(result.toPull).to.have.lengthOf(1);
			expect(result.toDeploy).to.be.empty;
			expect(result.toRemove).to.be.empty;
		});

		it('emits no work at steady state', () => {
			const current: ExtensionState[] = [
				row({
					serviceName: 'kernel-modules',
					image: `registry/km@${DIGEST_A}`,
					containerId: 'id-1',
				}),
			];
			const target = [
				overlayService({
					serviceName: 'kernel-modules',
					image: `registry/km@${DIGEST_A}`,
				}),
			];

			const result = compareExtensions(current, target);

			expect(result.toPull).to.be.empty;
			expect(result.toDeploy).to.be.empty;
			expect(result.toRemove).to.be.empty;
		});

		it('emits toRemove for a dropped service', () => {
			const current: ExtensionState[] = [
				row({ serviceName: 'gone', image: `registry/gone@${DIGEST_A}` }),
			];

			const result = compareExtensions(current, []);

			expect(result.toRemove).to.have.lengthOf(1);
			expect(result.toRemove[0].serviceName).to.equal('gone');
		});

		it('emits toRemove when profile goes off', () => {
			const current: ExtensionState[] = [
				row({
					serviceName: 'kernel-modules',
					image: `registry/km@${DIGEST_A}`,
				}),
			];
			const target = [
				overlayService({
					serviceName: 'kernel-modules',
					image: `registry/km@${DIGEST_A}`,
					profiles: ['kernel-modules'],
				}),
			];

			const result = compareExtensions(current, target, new Set());

			expect(result.toRemove).to.have.lengthOf(1);
			expect(result.toRemove[0].serviceName).to.equal('kernel-modules');
			expect(result.toDeploy).to.be.empty;
			expect(result.toPull).to.be.empty;
		});

		it('superseded digest (same service, profile active) → keep both, NO toRemove', () => {
			const current: ExtensionState[] = [
				row({
					serviceName: 'kernel-modules',
					image: `registry/km@${DIGEST_A}`,
					containerId: 'v1-container',
				}),
			];
			const target = [
				overlayService({
					serviceName: 'kernel-modules',
					image: `registry/km@${DIGEST_B}`,
				}),
			];

			const result = compareExtensions(
				current,
				target,
				new Set(['kernel-modules']),
			);

			expect(result.toPull).to.have.lengthOf(1);
			expect(imageKey(result.toPull[0].image)).to.equal(DIGEST_B);
			expect(result.toDeploy).to.have.lengthOf(1);
			expect(imageKey(result.toDeploy[0].image)).to.equal(DIGEST_B);
			expect(result.toRemove).to.be.empty;
		});

		it('profile re-activation after removal emits toPull + toDeploy', () => {
			const target = [
				overlayService({
					serviceName: 'kernel-modules',
					image: `registry/km@${DIGEST_A}`,
					profiles: ['kernel-modules'],
				}),
			];

			const result = compareExtensions([], target, new Set(['kernel-modules']));

			expect(result.toPull).to.have.lengthOf(1);
			expect(result.toDeploy).to.have.lengthOf(1);
			expect(result.toRemove).to.be.empty;
		});

		it('treats references sharing a digest as identical (no work)', () => {
			const current: ExtensionState[] = [
				row({
					serviceName: 'kernel-modules',
					image: `registry-old/km@${DIGEST_A}`,
					containerId: 'id-1',
				}),
			];
			const target = [
				overlayService({
					serviceName: 'kernel-modules',
					image: `registry-new/km@${DIGEST_A}`,
				}),
			];

			const result = compareExtensions(current, target);

			expect(result.toPull).to.be.empty;
			expect(result.toDeploy).to.be.empty;
			expect(result.toRemove).to.be.empty;
		});
	});

	describe('removeDroppedExtensions', () => {
		let getContainerStub: SinonStub;
		let removeStub: SinonStub;

		beforeEach(() => {
			removeStub = stub().resolves();
			getContainerStub = stub(dockerUtils.docker, 'getContainer').returns({
				remove: removeStub,
			} as any);
		});
		afterEach(() => {
			getContainerStub.restore();
		});

		it('force-removes each container in the list', async () => {
			const toRemove: ExtensionState[] = [
				row({
					serviceName: 'a',
					image: `registry/a@${DIGEST_A}`,
					containerId: 'cid-a',
				}),
				row({
					serviceName: 'b',
					image: `registry/b@${DIGEST_B}`,
					containerId: 'cid-b',
				}),
			];

			await removeDroppedExtensions(toRemove);

			expect(getContainerStub.calledWith('cid-a')).to.be.true;
			expect(getContainerStub.calledWith('cid-b')).to.be.true;
			expect(removeStub.callCount).to.equal(2);
		});

		it('tolerates a 404 from container remove', async () => {
			removeStub.rejects({ statusCode: 404 });
			const toRemove: ExtensionState[] = [
				row({
					serviceName: 'gone',
					image: `registry/g@${DIGEST_A}`,
					containerId: 'cid-x',
				}),
			];

			await removeDroppedExtensions(toRemove);
			expect(removeStub.calledOnce).to.be.true;
		});

		it('propagates non-404 engine errors', async () => {
			removeStub.rejects({ statusCode: 500, message: 'engine down' });
			const toRemove: ExtensionState[] = [
				row({
					serviceName: 'g',
					image: `registry/g@${DIGEST_A}`,
					containerId: 'cid-y',
				}),
			];

			try {
				await removeDroppedExtensions(toRemove);
				expect.fail('should have thrown');
			} catch (err: any) {
				expect(err.statusCode).to.equal(500);
			}
		});
	});

	describe('ensureExtensionImage', () => {
		let getImageStub: SinonStub;
		let fetchImageStub: SinonStub;
		let configGetStub: SinonStub;

		beforeEach(() => {
			getImageStub = stub(dockerUtils.docker, 'getImage');
			fetchImageStub = stub(dockerUtils, 'fetchImageWithProgress').resolves();
			configGetStub = stub(config, 'get').resolves({});
		});
		afterEach(() => {
			getImageStub.restore();
			fetchImageStub.restore();
			configGetStub.restore();
		});

		it('skips pull when the image is already local', async () => {
			getImageStub.returns({
				inspect: stub().resolves({ Id: 'sha256:abc' }),
			} as any);

			await ensureExtensionImage(
				`registry/km@${DIGEST_A}`,
				new AbortController().signal,
			);

			expect(fetchImageStub.called).to.be.false;
		});

		it('pulls via fetchImageWithProgress when the image is missing', async () => {
			getImageStub.returns({
				inspect: stub().rejects({ statusCode: 404 }),
			} as any);

			await ensureExtensionImage(
				`registry/km@${DIGEST_A}`,
				new AbortController().signal,
			);

			expect(fetchImageStub.calledOnce).to.be.true;
		});
	});

	describe('ensureExtensionContainer', () => {
		let createContainerStub: SinonStub;
		let getContainerStub: SinonStub;
		let setRebootBreadcrumbStub: SinonStub;

		let startStub: SinonStub;
		let removeStub: SinonStub;
		let inspectStub: SinonStub;

		beforeEach(() => {
			startStub = stub().resolves();
			removeStub = stub().resolves();
			inspectStub = stub().rejects({ statusCode: 404 });

			createContainerStub = stub(
				dockerUtils.docker,
				'createContainer',
			).resolves({
				id: 'test-container-id',
				start: startStub,
			} as any);

			getContainerStub = stub(dockerUtils.docker, 'getContainer').returns({
				remove: removeStub,
				inspect: inspectStub,
			} as any);

			setRebootBreadcrumbStub = stub(reboot, 'setRebootBreadcrumb').resolves();
		});
		afterEach(() => {
			createContainerStub.restore();
			getContainerStub.restore();
			setRebootBreadcrumbStub.restore();
		});

		it('creates and starts the container under a digest-suffixed name', async () => {
			const image = `registry/km@${DIGEST_A}`;
			const containerId = await ensureExtensionContainer(
				'kernel-modules',
				image,
				{ 'io.balena.image.class': 'overlay' },
			);

			expect(createContainerStub.calledOnce).to.be.true;
			const createArgs = createContainerStub.firstCall.args[0];
			expect(createArgs.name).to.equal(
				containerNameFor('kernel-modules', image),
			);
			expect(createArgs.Image).to.equal(image);
			expect(createArgs.HostConfig.Runtime).to.equal('extension');
			expect(startStub.calledOnce).to.be.true;
			expect(containerId).to.equal('test-container-id');
		});

		it('sets the reboot breadcrumb when the extension requires reboot', async () => {
			await ensureExtensionContainer(
				'kernel-modules',
				`registry/km@${DIGEST_A}`,
				{
					'io.balena.image.class': 'overlay',
					'io.balena.update.requires-reboot': '1',
				},
			);

			expect(setRebootBreadcrumbStub.calledOnce).to.be.true;
		});

		it('does not set the reboot breadcrumb when not required', async () => {
			await ensureExtensionContainer(
				'kernel-modules',
				`registry/km@${DIGEST_A}`,
				{ 'io.balena.image.class': 'overlay' },
			);

			expect(setRebootBreadcrumbStub.called).to.be.false;
		});

		it('propagates errors from container creation', async () => {
			createContainerStub.rejects(new Error('runtime not found'));

			try {
				await ensureExtensionContainer(
					'kernel-modules',
					`registry/km@${DIGEST_A}`,
					{ 'io.balena.image.class': 'overlay' },
				);
				expect.fail('should have thrown');
			} catch (err: any) {
				expect(err.message).to.equal('runtime not found');
			}
		});

		it('skips deploy when a dead container has a busy mount', async () => {
			inspectStub.resolves({
				Id: 'dead-container-id',
				State: { Status: 'dead' },
			});
			removeStub.rejects({
				statusCode: 500,
				message: 'device or resource busy',
			});

			const containerId = await ensureExtensionContainer(
				'kernel-modules',
				`registry/km@${DIGEST_A}`,
				{ 'io.balena.image.class': 'overlay' },
			);

			expect(containerId).to.equal('dead-container-id');
			expect(createContainerStub.called).to.be.false;
		});

		it('reuses a canonical-named exited container', async () => {
			inspectStub.resolves({ Id: 'existing-id', State: { Status: 'exited' } });

			const containerId = await ensureExtensionContainer(
				'kernel-modules',
				`registry/km@${DIGEST_A}`,
				{ 'io.balena.image.class': 'overlay' },
			);

			expect(containerId).to.equal('existing-id');
			expect(createContainerStub.called).to.be.false;
		});

		it('removes and redeploys a dead container when removal succeeds', async () => {
			inspectStub.resolves({ Id: 'dead-id', State: { Status: 'dead' } });
			removeStub.resolves();

			const containerId = await ensureExtensionContainer(
				'kernel-modules',
				`registry/km@${DIGEST_A}`,
				{ 'io.balena.image.class': 'overlay' },
			);

			expect(createContainerStub.calledOnce).to.be.true;
			expect(containerId).to.equal('test-container-id');
		});
	});

	describe('removeExtensionContainer', () => {
		let getContainerStub: SinonStub;
		let removeStub: SinonStub;

		beforeEach(() => {
			removeStub = stub().resolves();
			getContainerStub = stub(dockerUtils.docker, 'getContainer').returns({
				remove: removeStub,
			} as any);
		});
		afterEach(() => {
			getContainerStub.restore();
		});

		it('force-removes the container', async () => {
			await removeExtensionContainer('cid-1');

			expect(getContainerStub.calledWith('cid-1')).to.be.true;
			expect(removeStub.calledOnce).to.be.true;
		});

		it('tolerates a 404 from remove', async () => {
			removeStub.rejects({ statusCode: 404 });
			await removeExtensionContainer('cid-1');
			expect(removeStub.calledOnce).to.be.true;
		});

		it('propagates non-404 errors', async () => {
			removeStub.rejects({ statusCode: 500, message: 'engine down' });
			try {
				await removeExtensionContainer('cid-1');
				expect.fail('should have thrown');
			} catch (err: any) {
				expect(err.statusCode).to.equal(500);
			}
		});
	});

	describe('deployExtensionContainer (wrapper)', () => {
		let getImageStub: SinonStub;
		let fetchImageStub: SinonStub;
		let configGetStub: SinonStub;
		let createContainerStub: SinonStub;
		let getContainerStub: SinonStub;
		let setRebootBreadcrumbStub: SinonStub;

		beforeEach(() => {
			getImageStub = stub(dockerUtils.docker, 'getImage').returns({
				inspect: stub().resolves({ Id: 'sha256:abc' }),
			} as any);
			fetchImageStub = stub(dockerUtils, 'fetchImageWithProgress').resolves();
			configGetStub = stub(config, 'get').resolves({});

			createContainerStub = stub(
				dockerUtils.docker,
				'createContainer',
			).resolves({
				id: 'test-container-id',
				start: stub().resolves(),
			} as any);
			getContainerStub = stub(dockerUtils.docker, 'getContainer').returns({
				remove: stub().resolves(),
				inspect: stub().rejects({ statusCode: 404 }),
			} as any);
			setRebootBreadcrumbStub = stub(reboot, 'setRebootBreadcrumb').resolves();
		});
		afterEach(() => {
			getImageStub.restore();
			fetchImageStub.restore();
			configGetStub.restore();
			createContainerStub.restore();
			getContainerStub.restore();
			setRebootBreadcrumbStub.restore();
		});

		it('skips pull when image is local, then creates the container', async () => {
			const image = `registry/km@${DIGEST_A}`;
			const id = await deployExtensionContainer(
				'kernel-modules',
				image,
				{ 'io.balena.image.class': 'overlay' },
				new AbortController().signal,
			);

			expect(fetchImageStub.called).to.be.false;
			expect(createContainerStub.calledOnce).to.be.true;
			expect(id).to.equal('test-container-id');
		});
	});
});
