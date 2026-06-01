import { expect } from 'chai';

import {
	extractOverlayServices,
	computeExtensionSteps,
} from '~/src/compose/application-manager';
import type { ExtensionChanges } from '~/src/compose/application-manager';
import type { TargetApps } from '~/src/types';

/**
 * Build a TargetApps fixture from plain objects.
 * Uses `as any` for branded string types (same approach as test/lib/state-helper.ts).
 */
function makeTargetApps(
	apps: Record<
		string,
		{
			is_host?: boolean;
			releases?: Record<
				string,
				{
					services?: Record<
						string,
						{
							image?: string;
							labels?: Record<string, string>;
							composition?: Record<string, unknown>;
						}
					>;
				}
			>;
		}
	>,
): TargetApps {
	const result: Record<string, any> = {};
	for (const [uuid, app] of Object.entries(apps)) {
		const releases: Record<string, any> = {};
		for (const [commit, rel] of Object.entries(app.releases ?? {})) {
			const services: Record<string, any> = {};
			for (const [name, svc] of Object.entries(rel.services ?? {})) {
				services[name] = {
					id: 1,
					image_id: 1,
					image: svc.image ?? `registry/${name}:latest`,
					environment: {},
					labels: svc.labels ?? {},
					...(svc.composition && { composition: svc.composition }),
				};
			}
			releases[commit] = { id: 1, services, volumes: {}, networks: {} };
		}
		result[uuid] = {
			id: 1,
			name: uuid,
			class: 'fleet' as const,
			releases,
			...(app.is_host && { is_host: true }),
		};
	}
	return result as any as TargetApps;
}

describe('compose/application-manager', () => {
	describe('extractOverlayServices', () => {
		it('returns empty array for empty apps', () => {
			const result = extractOverlayServices(makeTargetApps({}));
			expect(result).to.deep.equal([]);
		});

		it('returns empty array when no host app exists', () => {
			const apps = makeTargetApps({
				app1: {
					releases: {
						rel1: {
							services: {
								web: {
									labels: { 'io.balena.image.class': 'overlay' },
								},
							},
						},
					},
				},
			});
			const result = extractOverlayServices(apps);
			expect(result).to.deep.equal([]);
		});

		it('extracts overlay services from host app', () => {
			const apps = makeTargetApps({
				hostapp: {
					is_host: true,
					releases: {
						rel1: {
							services: {
								'kernel-modules': {
									image: 'registry/kernel-modules:v1',
									labels: { 'io.balena.image.class': 'overlay' },
								},
							},
						},
					},
				},
			});
			const result = extractOverlayServices(apps);
			expect(result).to.have.lengthOf(1);
			expect(result[0]).to.include({
				serviceName: 'kernel-modules',
				image: 'registry/kernel-modules:v1',
			});
		});

		it('skips non-overlay services in host app', () => {
			const apps = makeTargetApps({
				hostapp: {
					is_host: true,
					releases: {
						rel1: {
							services: {
								'kernel-modules': {
									image: 'registry/kernel-modules:v1',
									labels: { 'io.balena.image.class': 'overlay' },
								},
								'regular-svc': {
									image: 'registry/regular:v1',
									labels: {},
								},
							},
						},
					},
				},
			});
			const result = extractOverlayServices(apps);
			expect(result).to.have.lengthOf(1);
			expect(result[0].serviceName).to.equal('kernel-modules');
		});

		it('extracts multiple overlay services', () => {
			const apps = makeTargetApps({
				hostapp: {
					is_host: true,
					releases: {
						rel1: {
							services: {
								'kernel-modules': {
									image: 'registry/kernel-modules:v1',
									labels: { 'io.balena.image.class': 'overlay' },
								},
								firmware: {
									image: 'registry/firmware:v1',
									labels: { 'io.balena.image.class': 'overlay' },
								},
							},
						},
					},
				},
			});
			const result = extractOverlayServices(apps);
			expect(result).to.have.lengthOf(2);
			const names = result.map((s) => s.serviceName);
			expect(names).to.have.members(['kernel-modules', 'firmware']);
		});
	});

	describe('computeExtensionSteps', () => {
		const abortSignal = new AbortController().signal;

		const changes = (
			over: Partial<ExtensionChanges> = {},
		): ExtensionChanges => ({
			toDeploy: [],
			toDrop: [],
			rebootServiceName: null,
			osUpdatePending: false,
			...over,
		});

		const deploy = (serviceName: string) => ({
			serviceName,
			image: `registry/${serviceName}@sha256:abc`,
			labels: { 'io.balena.image.class': 'overlay' },
		});

		const drop = (serviceName: string) => ({
			serviceName,
			containerId: `cid-${serviceName}`,
		});

		it('emits deploy steps that gate app reconciliation', () => {
			const { gating, removals } = computeExtensionSteps(
				changes({ toDeploy: [deploy('kmods')] }),
				false,
				abortSignal,
			);
			expect(gating.map((s) => s.action)).to.deep.equal(['deployExtension']);
			expect(removals).to.be.empty;
		});

		it('emits removals as non-gating, not in the gating set', () => {
			const { gating, removals } = computeExtensionSteps(
				changes({ toDrop: [drop('old')] }),
				false,
				abortSignal,
			);
			// A pure drop must NOT gate apps.
			expect(gating).to.be.empty;
			expect(removals.map((s) => s.action)).to.deep.equal([
				'removeExtensionContainer',
			]);
		});

		it('deploys and removes in the same pass (removals stay non-gating)', () => {
			const { gating, removals } = computeExtensionSteps(
				changes({ toDeploy: [deploy('new')], toDrop: [drop('old')] }),
				false,
				abortSignal,
			);
			expect(gating.map((s) => s.action)).to.deep.equal(['deployExtension']);
			expect(removals.map((s) => s.action)).to.deep.equal([
				'removeExtensionContainer',
			]);
		});

		it('skips removals once a reboot is pending so the loop can drain to all-noop', () => {
			const { removals } = computeExtensionSteps(
				changes({ toDrop: [drop('old')] }),
				true,
				abortSignal,
			);
			expect(removals).to.be.empty;
		});

		it('gates on the activation reboot when nothing is being deployed', () => {
			const { gating } = computeExtensionSteps(
				changes({ rebootServiceName: 'kmods' }),
				false,
				abortSignal,
			);
			expect(gating.map((s) => s.action)).to.deep.equal(['requireReboot']);
		});

		it('does not re-emit the reboot once the breadcrumb is set', () => {
			const { gating } = computeExtensionSteps(
				changes({ rebootServiceName: 'kmods' }),
				true,
				abortSignal,
			);
			expect(gating).to.be.empty;
		});

		it('defers the activation reboot to a noop while a host OS update is pending', () => {
			const { gating } = computeExtensionSteps(
				changes({ rebootServiceName: 'kmods', osUpdatePending: true }),
				false,
				abortSignal,
			);
			expect(gating.map((s) => s.action)).to.deep.equal(['noop']);
		});

		it('deploys take precedence over the activation reboot in a single pass', () => {
			const { gating } = computeExtensionSteps(
				changes({ toDeploy: [deploy('kmods')], rebootServiceName: 'kmods' }),
				false,
				abortSignal,
			);
			expect(gating.map((s) => s.action)).to.deep.equal(['deployExtension']);
		});

		it('produces nothing when there is no extension work', () => {
			const { gating, removals } = computeExtensionSteps(
				changes(),
				false,
				abortSignal,
			);
			expect(gating).to.be.empty;
			expect(removals).to.be.empty;
		});
	});
});
