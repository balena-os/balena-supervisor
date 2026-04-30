import { expect } from 'chai';

import {
	extractUserServiceProfiles,
	extractOverlayServices,
} from '~/src/compose/application-manager';
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
	describe('extractUserServiceProfiles', () => {
		it('returns empty set for empty apps', () => {
			const profiles = extractUserServiceProfiles(makeTargetApps({}));
			expect(profiles.size).to.equal(0);
		});

		it('returns empty set when no services have profiles', () => {
			const apps = makeTargetApps({
				app1: {
					releases: {
						rel1: {
							services: {
								web: { image: 'web:latest' },
							},
						},
					},
				},
			});
			const profiles = extractUserServiceProfiles(apps);
			expect(profiles.size).to.equal(0);
		});

		it('skips host apps', () => {
			const apps = makeTargetApps({
				hostapp: {
					is_host: true,
					releases: {
						rel1: {
							services: {
								svc: {
									composition: { profiles: ['kernel-modules'] },
								},
							},
						},
					},
				},
			});
			const profiles = extractUserServiceProfiles(apps);
			expect(profiles.size).to.equal(0);
		});

		it('collects profiles from a single service', () => {
			const apps = makeTargetApps({
				app1: {
					releases: {
						rel1: {
							services: {
								web: {
									composition: { profiles: ['gpu', 'audio'] },
								},
							},
						},
					},
				},
			});
			const profiles = extractUserServiceProfiles(apps);
			expect([...profiles]).to.have.members(['gpu', 'audio']);
		});

		it('collects profiles from multiple services across multiple apps', () => {
			const apps = makeTargetApps({
				app1: {
					releases: {
						rel1: {
							services: {
								web: {
									composition: { profiles: ['gpu'] },
								},
							},
						},
					},
				},
				app2: {
					releases: {
						rel2: {
							services: {
								worker: {
									composition: { profiles: ['audio'] },
								},
							},
						},
					},
				},
			});
			const profiles = extractUserServiceProfiles(apps);
			expect([...profiles]).to.have.members(['gpu', 'audio']);
		});

		it('deduplicates profiles', () => {
			const apps = makeTargetApps({
				app1: {
					releases: {
						rel1: {
							services: {
								web: {
									composition: { profiles: ['gpu'] },
								},
								worker: {
									composition: { profiles: ['gpu'] },
								},
							},
						},
					},
				},
			});
			const profiles = extractUserServiceProfiles(apps);
			expect(profiles.size).to.equal(1);
			expect(profiles.has('gpu')).to.be.true;
		});

		it('handles empty profiles array', () => {
			const apps = makeTargetApps({
				app1: {
					releases: {
						rel1: {
							services: {
								web: {
									composition: { profiles: [] },
								},
							},
						},
					},
				},
			});
			const profiles = extractUserServiceProfiles(apps);
			expect(profiles.size).to.equal(0);
		});

		it('handles missing composition', () => {
			const apps = makeTargetApps({
				app1: {
					releases: {
						rel1: {
							services: {
								web: {},
							},
						},
					},
				},
			});
			const profiles = extractUserServiceProfiles(apps);
			expect(profiles.size).to.equal(0);
		});

		it('handles non-array composition.profiles', () => {
			const apps = makeTargetApps({
				app1: {
					releases: {
						rel1: {
							services: {
								web: {
									composition: { profiles: 'not-an-array' },
								},
							},
						},
					},
				},
			});
			const profiles = extractUserServiceProfiles(apps);
			expect(profiles.size).to.equal(0);
		});

		it('only collects profiles from user apps, not host apps', () => {
			const apps = makeTargetApps({
				hostapp: {
					is_host: true,
					releases: {
						rel1: {
							services: {
								overlay: {
									composition: { profiles: ['host-profile'] },
								},
							},
						},
					},
				},
				userapp: {
					releases: {
						rel1: {
							services: {
								web: {
									composition: { profiles: ['user-profile'] },
								},
							},
						},
					},
				},
			});
			const profiles = extractUserServiceProfiles(apps);
			expect([...profiles]).to.deep.equal(['user-profile']);
		});
	});

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

		it('includes profiles from overlay service composition', () => {
			const apps = makeTargetApps({
				hostapp: {
					is_host: true,
					releases: {
						rel1: {
							services: {
								'kernel-modules': {
									image: 'registry/kernel-modules:v1',
									labels: { 'io.balena.image.class': 'overlay' },
									composition: { profiles: ['gpu'] },
								},
							},
						},
					},
				},
			});
			const result = extractOverlayServices(apps);
			expect(result).to.have.lengthOf(1);
			expect(result[0].profiles).to.deep.equal(['gpu']);
		});

		it('sets profiles to undefined when not present in composition', () => {
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
			expect(result[0].profiles).to.be.undefined;
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
									composition: { profiles: ['gpu'] },
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
});
