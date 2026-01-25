import { expect } from 'chai';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import {
	filterByActiveProfiles,
	compareExtensions,
	isOverlayService,
	isDataStore,
	handleOverlayExtensions,
	type ExtensionState,
} from '~/src/compose/extensions';
import type { ServiceComposeConfig } from '~/src/compose/types/service';
import * as fsUtils from '~/src/lib/fs-utils';
import * as reboot from '~/src/lib/reboot';

describe('compose/extensions', () => {
	describe('isOverlayService', () => {
		it('should return true for services with io.balena.image.class=overlay', () => {
			const svc = {
				image: 'test:latest',
				labels: { 'io.balena.image.class': 'overlay' },
			} as ServiceComposeConfig;
			expect(isOverlayService(svc)).to.be.true;
		});

		it('should return false for services with different class', () => {
			const svc = {
				image: 'test:latest',
				labels: { 'io.balena.image.class': 'service' },
			} as ServiceComposeConfig;
			expect(isOverlayService(svc)).to.be.false;
		});

		it('should return false for services without class label', () => {
			const svc = {
				image: 'test:latest',
				labels: {},
			} as ServiceComposeConfig;
			expect(isOverlayService(svc)).to.be.false;
		});

		it('should return false for services without labels', () => {
			const svc = {
				image: 'test:latest',
			} as ServiceComposeConfig;
			expect(isOverlayService(svc)).to.be.false;
		});
	});

	describe('isDataStore', () => {
		it('should return true for services with io.balena.image.store=data', () => {
			const svc = {
				image: 'test:latest',
				labels: { 'io.balena.image.store': 'data' },
			} as ServiceComposeConfig;
			expect(isDataStore(svc)).to.be.true;
		});

		it('should return true for services without store label (default)', () => {
			const svc = {
				image: 'test:latest',
				labels: {},
			} as ServiceComposeConfig;
			expect(isDataStore(svc)).to.be.true;
		});

		it('should return false for services with store=root', () => {
			const svc = {
				image: 'test:latest',
				labels: { 'io.balena.image.store': 'root' },
			} as ServiceComposeConfig;
			expect(isDataStore(svc)).to.be.false;
		});
	});

	describe('filterByActiveProfiles', () => {
		it('should include services without profiles (backward compatible)', () => {
			const services: ServiceComposeConfig[] = [
				{ serviceName: 'svc1', image: 'img1:latest' } as ServiceComposeConfig,
				{ serviceName: 'svc2', image: 'img2:latest' } as ServiceComposeConfig,
			];
			const activeProfiles = new Set<string>();

			const result = filterByActiveProfiles(services, activeProfiles);
			expect(result).to.have.lengthOf(2);
		});

		it('should include services with empty profiles array', () => {
			const services: ServiceComposeConfig[] = [
				{
					serviceName: 'svc1',
					image: 'img1:latest',
					profiles: [],
				} as ServiceComposeConfig,
			];
			const activeProfiles = new Set<string>();

			const result = filterByActiveProfiles(services, activeProfiles);
			expect(result).to.have.lengthOf(1);
		});

		it('should include services with matching profiles', () => {
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
			const activeProfiles = new Set(['kernel-modules']);

			const result = filterByActiveProfiles(services, activeProfiles);
			expect(result).to.have.lengthOf(1);
			expect(result[0].serviceName).to.equal('kernel-modules');
		});

		it('should include services with any matching profile', () => {
			const services: ServiceComposeConfig[] = [
				{
					serviceName: 'multi-profile',
					image: 'img1:latest',
					profiles: ['profile-a', 'profile-b'],
				} as ServiceComposeConfig,
			];
			const activeProfiles = new Set(['profile-b']);

			const result = filterByActiveProfiles(services, activeProfiles);
			expect(result).to.have.lengthOf(1);
		});

		it('should exclude services with non-matching profiles', () => {
			const services: ServiceComposeConfig[] = [
				{
					serviceName: 'svc1',
					image: 'img1:latest',
					profiles: ['inactive-profile'],
				} as ServiceComposeConfig,
			];
			const activeProfiles = new Set(['active-profile']);

			const result = filterByActiveProfiles(services, activeProfiles);
			expect(result).to.have.lengthOf(0);
		});
	});

	describe('compareExtensions', () => {
		it('should identify new extensions to add', () => {
			const current: ExtensionState[] = [];
			const target: ServiceComposeConfig[] = [
				{
					serviceName: 'kernel-modules',
					image: 'registry/kernel-modules:v1',
				} as ServiceComposeConfig,
			];

			const { toAdd, toRemove, toUpdate } = compareExtensions(current, target);
			expect(toAdd).to.have.lengthOf(1);
			expect(toAdd[0].serviceName).to.equal('kernel-modules');
			expect(toRemove).to.have.lengthOf(0);
			expect(toUpdate).to.have.lengthOf(0);
		});

		it('should identify extensions to remove', () => {
			const current: ExtensionState[] = [
				{
					serviceName: 'old-extension',
					image: 'registry/old:v1',
					deployedAt: '2024-01-01T00:00:00Z',
				},
			];
			const target: ServiceComposeConfig[] = [];

			const { toAdd, toRemove, toUpdate } = compareExtensions(current, target);
			expect(toAdd).to.have.lengthOf(0);
			expect(toRemove).to.have.lengthOf(1);
			expect(toRemove[0].serviceName).to.equal('old-extension');
			expect(toUpdate).to.have.lengthOf(0);
		});

		it('should identify extensions to update (image changed)', () => {
			const current: ExtensionState[] = [
				{
					serviceName: 'kernel-modules',
					image: 'registry/kernel-modules:v1',
					deployedAt: '2024-01-01T00:00:00Z',
				},
			];
			const target: ServiceComposeConfig[] = [
				{
					serviceName: 'kernel-modules',
					image: 'registry/kernel-modules:v2',
				} as ServiceComposeConfig,
			];

			const { toAdd, toRemove, toUpdate } = compareExtensions(current, target);
			expect(toAdd).to.have.lengthOf(0);
			expect(toRemove).to.have.lengthOf(0);
			expect(toUpdate).to.have.lengthOf(1);
			expect(toUpdate[0].serviceName).to.equal('kernel-modules');
		});

		it('should not flag unchanged extensions', () => {
			const current: ExtensionState[] = [
				{
					serviceName: 'kernel-modules',
					image: 'registry/kernel-modules:v1',
					deployedAt: '2024-01-01T00:00:00Z',
				},
			];
			const target: ServiceComposeConfig[] = [
				{
					serviceName: 'kernel-modules',
					image: 'registry/kernel-modules:v1',
				} as ServiceComposeConfig,
			];

			const { toAdd, toRemove, toUpdate } = compareExtensions(current, target);
			expect(toAdd).to.have.lengthOf(0);
			expect(toRemove).to.have.lengthOf(0);
			expect(toUpdate).to.have.lengthOf(0);
		});

		it('should handle complex scenarios with add, remove, and update', () => {
			const current: ExtensionState[] = [
				{
					serviceName: 'to-remove',
					image: 'registry/remove:v1',
					deployedAt: '2024-01-01T00:00:00Z',
				},
				{
					serviceName: 'to-update',
					image: 'registry/update:v1',
					deployedAt: '2024-01-01T00:00:00Z',
				},
				{
					serviceName: 'unchanged',
					image: 'registry/unchanged:v1',
					deployedAt: '2024-01-01T00:00:00Z',
				},
			];
			const target: ServiceComposeConfig[] = [
				{
					serviceName: 'to-add',
					image: 'registry/add:v1',
				} as ServiceComposeConfig,
				{
					serviceName: 'to-update',
					image: 'registry/update:v2',
				} as ServiceComposeConfig,
				{
					serviceName: 'unchanged',
					image: 'registry/unchanged:v1',
				} as ServiceComposeConfig,
			];

			const { toAdd, toRemove, toUpdate } = compareExtensions(current, target);
			expect(toAdd).to.have.lengthOf(1);
			expect(toAdd[0].serviceName).to.equal('to-add');
			expect(toRemove).to.have.lengthOf(1);
			expect(toRemove[0].serviceName).to.equal('to-remove');
			expect(toUpdate).to.have.lengthOf(1);
			expect(toUpdate[0].serviceName).to.equal('to-update');
		});
	});

	describe('handleOverlayExtensions', () => {
		let execFileStub: SinonStub;
		let setRebootBreadcrumbStub: SinonStub;

		beforeEach(() => {
			execFileStub = stub(fsUtils, 'execFile');
			setRebootBreadcrumbStub = stub(reboot, 'setRebootBreadcrumb').resolves();
		});

		afterEach(() => {
			execFileStub.restore();
			setRebootBreadcrumbStub.restore();
		});

		it('should return early when no changes needed', async () => {
			const overlayServices: ServiceComposeConfig[] = [];
			const activeProfiles = new Set<string>();

			const result = await handleOverlayExtensions(
				overlayServices,
				activeProfiles,
				[],
			);

			expect(result.needsReboot).to.be.false;
			expect(result.deployed).to.have.lengthOf(0);
			expect(result.removed).to.have.lengthOf(0);
			expect(execFileStub.called).to.be.false;
		});

		it('should call update-hostapp-extensions with image list', async () => {
			execFileStub.resolves({ stdout: '', stderr: '' });

			const overlayServices: ServiceComposeConfig[] = [
				{
					serviceName: 'kernel-modules',
					image: 'registry/kernel-modules:v1',
					labels: { 'io.balena.image.class': 'overlay' },
				} as ServiceComposeConfig,
			];
			const activeProfiles = new Set<string>();

			const result = await handleOverlayExtensions(
				overlayServices,
				activeProfiles,
				[],
			);

			expect(execFileStub.calledOnce).to.be.true;
			expect(execFileStub.firstCall.args[0]).to.equal(
				'update-hostapp-extensions',
			);
			expect(execFileStub.firstCall.args[1]).to.deep.equal([
				'-t',
				'registry/kernel-modules:v1',
			]);
			expect(result.deployed).to.include('kernel-modules');
			expect(result.error).to.be.undefined;
		});

		it('should not pass -t when no images match profiles', async () => {
			const overlayServices: ServiceComposeConfig[] = [
				{
					serviceName: 'kernel-modules',
					image: 'registry/kernel-modules:v1',
					labels: { 'io.balena.image.class': 'overlay' },
					profiles: ['some-profile'],
				} as ServiceComposeConfig,
			];
			const activeProfiles = new Set<string>(); // No active profiles

			const result = await handleOverlayExtensions(
				overlayServices,
				activeProfiles,
				[],
			);

			// Service filtered out by profile, no changes needed
			expect(result.needsReboot).to.be.false;
			expect(result.deployed).to.have.lengthOf(0);
			expect(execFileStub.called).to.be.false;
		});

		it('should return error on execFile failure', async () => {
			execFileStub.rejects(new Error('Command failed'));

			const overlayServices: ServiceComposeConfig[] = [
				{
					serviceName: 'kernel-modules',
					image: 'registry/kernel-modules:v1',
					labels: { 'io.balena.image.class': 'overlay' },
				} as ServiceComposeConfig,
			];
			const activeProfiles = new Set<string>();

			const result = await handleOverlayExtensions(
				overlayServices,
				activeProfiles,
				[],
			);

			expect(result.error).to.include('Failed to deploy overlay extensions');
			expect(result.deployed).to.have.lengthOf(0);
		});

		it('should set reboot breadcrumb when extension requires reboot', async () => {
			execFileStub.resolves({ stdout: '', stderr: '' });

			const overlayServices: ServiceComposeConfig[] = [
				{
					serviceName: 'kernel-modules',
					image: 'registry/kernel-modules:v1',
					labels: {
						'io.balena.image.class': 'overlay',
						'io.balena.image.requires-reboot': '1',
					},
				} as ServiceComposeConfig,
			];
			const activeProfiles = new Set<string>();

			const result = await handleOverlayExtensions(
				overlayServices,
				activeProfiles,
				[],
			);

			expect(result.needsReboot).to.be.true;
			expect(setRebootBreadcrumbStub.calledOnce).to.be.true;
		});
	});
});
