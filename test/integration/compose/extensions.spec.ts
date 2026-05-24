import { expect } from 'chai';
import Docker from 'dockerode';

import {
	getDeployedExtensions,
	deployExtensionContainer,
	containerNameFor,
} from '~/src/compose/extensions';
import { createDockerImage } from '~/test-lib/docker-helper';

const CLASS = 'io.balena.image.class';
const SERVICE = 'io.balena.service-name';

describe('compose/extensions [integration]', () => {
	const docker = new Docker();
	// alpine has true/false/sleep, so we can drive State.Status/ExitCode
	// deterministically. The getDeployedExtensions filter reads *container*
	// labels via inspect, so we set the overlay labels on each container.
	const BASE = 'alpine:3.19';

	// Build a labelled image and return a digest-pinned local reference the
	// engine accepts for createContainer.
	async function digestPinnedImage(
		d: Docker,
		tag: string,
		labels: string[],
	): Promise<string> {
		await createDockerImage(tag, labels as [string, ...string[]], d);
		const info = await d.getImage(tag).inspect();
		// balenaEngine accepts the `<tag>@sha256:<id>` (content-id) form for
		// createContainer on a local image, which is enough to exercise the
		// digest-pinned deploy path without a registry round-trip.
		const digest = info.Id; // sha256:<hex>
		return `${tag}@${digest}`;
	}

	before(async function () {
		this.timeout(60000);
		const stream = await docker.pull(BASE);
		await new Promise<void>((resolve, reject) => {
			docker.modem.followProgress(stream, (err: Error | null) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	});

	// Remove only overlay-labelled containers between tests, leaving the
	// pulled image in place so subsequent tests don't need to re-pull.
	afterEach(async function () {
		this.timeout(30000);
		const containers = await docker.listContainers({
			all: true,
			filters: { label: [`${CLASS}=overlay`] },
		});
		await Promise.all(
			containers.map(({ Id }) =>
				docker.getContainer(Id).remove({ force: true }),
			),
		);
	});

	describe('getDeployedExtensions', () => {
		it('reports an exited-0 container carrying the service-name label', async () => {
			const c = await docker.createContainer({
				name: 'ext_kmods_good',
				Image: BASE,
				Cmd: ['true'],
				Labels: { [CLASS]: 'overlay', [SERVICE]: 'kmods' },
			});
			await c.start();
			await c.wait();

			const deployed = await getDeployedExtensions();
			expect(deployed).to.have.length(1);
			expect(deployed[0].serviceName).to.equal('kmods');
			expect(deployed[0].containerId).to.equal(c.id);
			expect(deployed[0].createdAt).to.be.instanceOf(Date);
			expect(deployed[0].labels[CLASS]).to.equal('overlay');
		});

		it('skips overlay containers without a service-name label', async () => {
			const c = await docker.createContainer({
				name: 'ext_nolabel',
				Image: BASE,
				Cmd: ['true'],
				Labels: { [CLASS]: 'overlay' },
			});
			await c.start();
			await c.wait();

			expect(await getDeployedExtensions()).to.be.empty;
		});

		it('does not report a never-started (created) container', async () => {
			await docker.createContainer({
				name: 'ext_kmods_created',
				Image: BASE,
				Cmd: ['true'],
				Labels: { [CLASS]: 'overlay', [SERVICE]: 'kmods' },
			});

			expect(await getDeployedExtensions()).to.be.empty;
		});

		it('does not report an exited-nonzero container', async () => {
			const c = await docker.createContainer({
				name: 'ext_kmods_fail',
				Image: BASE,
				Cmd: ['false'],
				Labels: { [CLASS]: 'overlay', [SERVICE]: 'kmods' },
			});
			await c.start();
			await c.wait();

			expect(await getDeployedExtensions()).to.be.empty;
		});

		it('does not report a still-running container', async () => {
			const c = await docker.createContainer({
				name: 'ext_kmods_run',
				Image: BASE,
				Cmd: ['sleep', '60'],
				Labels: { [CLASS]: 'overlay', [SERVICE]: 'kmods' },
			});
			await c.start();

			expect(await getDeployedExtensions()).to.be.empty;
		});
	});

	describe('deployExtensionContainer', () => {
		before(async function () {
			const info = await docker.info();
			if (!info.Runtimes?.extension) {
				this.skip();
			}
		});

		const ac = new AbortController();

		it('creates an exited-0 container with full labels + service-name', async () => {
			const image = await digestPinnedImage(docker, 'ext-deploy', [
				`${CLASS}=overlay`,
				'io.balena.image.store=data',
			]);
			const id = await deployExtensionContainer(
				'kmods',
				image,
				{ [CLASS]: 'overlay', 'io.balena.image.store': 'data' },
				ac.signal,
			);
			const info = await docker.getContainer(id).inspect();
			expect(info.Config?.Labels?.[SERVICE]).to.equal('kmods');
			expect(info.Config?.Labels?.[CLASS]).to.equal('overlay');
			expect(info.Name).to.contain(containerNameFor('kmods', image).slice(1));
		});

		it('does not 409 when a stale canonical-named container exists', async () => {
			const image = await digestPinnedImage(docker, 'ext-stale', [
				`${CLASS}=overlay`,
			]);
			const name = containerNameFor('kmods', image);
			await docker.createContainer({
				name,
				Image: image,
				Cmd: ['none'],
				Labels: { [CLASS]: 'overlay', [SERVICE]: 'kmods' },
			});
			const id = await deployExtensionContainer(
				'kmods',
				image,
				{ [CLASS]: 'overlay' },
				ac.signal,
			);
			expect(id).to.be.a('string');
		});

		it('adopts an existing exited-0 canonical container instead of recreating', async () => {
			const image = await digestPinnedImage(docker, 'ext-adopt', [
				`${CLASS}=overlay`,
			]);
			const first = await deployExtensionContainer(
				'kmods',
				image,
				{ [CLASS]: 'overlay' },
				ac.signal,
			);
			await docker.getContainer(first).wait();
			// A second deploy of the same (serviceName, digest) must reuse the
			// already-good container rather than remove + recreate it.
			const second = await deployExtensionContainer(
				'kmods',
				image,
				{ [CLASS]: 'overlay' },
				ac.signal,
			);
			expect(second).to.equal(first);
		});
	});
});
