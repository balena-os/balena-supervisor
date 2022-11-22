import { expect } from 'chai';
import Docker from 'dockerode';
import * as sinon from 'sinon';

import * as db from '~/src/db';
import { docker } from '~/lib/docker-utils';
import LocalModeManager, {
	EngineSnapshot,
	EngineSnapshotRecord,
} from '~/src/local-mode';
import ShortStackError from '~/test-lib/errors';

describe('LocalModeManager', () => {
	let localMode: LocalModeManager;
	let dockerStub: sinon.SinonStubbedInstance<typeof docker>;

	const supervisorContainerId = 'super-container-1';

	const recordsCount = async () =>
		await db
			.models('engineSnapshot')
			.count('* as cnt')
			.first()
			.then((r) => r.cnt);

	// Cleanup the database (to make sure nothing is left since last tests).
	beforeEach(async () => {
		await db.models('engineSnapshot').delete();
	});

	before(async () => {
		await db.initialized();

		dockerStub = sinon.stub(docker);

		localMode = new LocalModeManager(supervisorContainerId);
	});

	after(async () => {
		sinon.restore();
	});

	describe('EngineSnapshot', () => {
		it('can calculate a diff', () => {
			const original = new EngineSnapshot(
				['c1', 'c2'],
				['i1'],
				['v1', 'v2'],
				['nn'],
			);
			const newOne = new EngineSnapshot(
				['c2', 'c3'],
				['i1', 'i2', 'i3'],
				['v1'],
				[],
			);
			const diff = newOne.diff(original);

			expect(diff.containers).to.deep.equal(['c3']);
			expect(diff.images).to.deep.equal(['i2', 'i3']);
			expect(diff.volumes).to.deep.equal([]);
			expect(diff.networks).to.deep.equal([]);
		});
	});

	describe('engine snapshots collection', () => {
		before(() => {
			// Stub the engine to return images, containers, volumes, and networks.
			dockerStub.listImages.returns(
				Promise.resolve([
					{ Id: 'image-1' } as Docker.ImageInfo,
					{ Id: 'image-2' } as Docker.ImageInfo,
				]),
			);
			dockerStub.listContainers.returns(
				Promise.resolve([
					{ Id: 'container-1' } as Docker.ContainerInfo,
					{ Id: 'container-2' } as Docker.ContainerInfo,
				]),
			);
			dockerStub.listVolumes.returns(
				Promise.resolve({
					Volumes: [
						{ Name: 'volume-1' } as Docker.VolumeInspectInfo,
						{ Name: 'volume-2' } as Docker.VolumeInspectInfo,
					],
					Warnings: [],
				}),
			);
			dockerStub.listNetworks.returns(
				Promise.resolve([{ Id: 'network-1' }, { Id: 'network-2' }]),
			);
		});

		it('collects all necessary engine entities', async () => {
			const snapshotRecord = await localMode.collectEngineSnapshot();

			expect(snapshotRecord.snapshot.containers).to.include(
				'container-1',
				'container-2',
			);
			expect(snapshotRecord.snapshot.images).to.include('image-1', 'image-2');
			expect(snapshotRecord.snapshot.volumes).to.include(
				'volume-1',
				'volume-2',
			);
			expect(snapshotRecord.snapshot.networks).to.include(
				'network-1',
				'network-2',
			);
		});

		it('marks snapshot with a timestamp', async () => {
			const startTime = new Date();
			const snapshotRecord = await localMode.collectEngineSnapshot();
			expect(snapshotRecord.timestamp).to.be.at.least(startTime);
		});

		describe('local mode switch', () => {
			// Info returned when we inspect our own container.
			const supervisorContainer = {
				Id: 'super-container-1',
				State: {
					Status: 'running',
					Running: true,
				},
				Image: 'super-image-1',
				HostConfig: {
					ContainerIDFile: '/resin-data/balena-supervisor/container-id',
				},
				Mounts: [
					{
						Type: 'volume',
						Name: 'super-volume-1',
					},
				],
				NetworkSettings: {
					Networks: {
						'some-name': {
							NetworkID: 'super-network-1',
						},
					},
				},
			};

			const storeCurrentSnapshot = async (
				containers: string[],
				images: string[],
				volumes: string[],
				networks: string[],
			) => {
				await localMode.storeEngineSnapshot(
					new EngineSnapshotRecord(
						new EngineSnapshot(containers, images, volumes, networks),
						new Date(),
					),
				);
			};

			interface EngineStubbedObject {
				remove(): Promise<void>;
				inspect(): Promise<any>;
			}

			// Stub get<Object> methods on docker, so we can verify remove calls.
			const stubEngineObjectMethods = (
				removeThrows: boolean,
			): Array<sinon.SinonStubbedInstance<EngineStubbedObject>> => {
				const resArray: Array<sinon.SinonStubbedInstance<EngineStubbedObject>> =
					[];

				const stub = <T>(
					c: sinon.StubbableType<EngineStubbedObject>,
					type: string,
				) => {
					const res = sinon.createStubInstance(c);
					if (removeThrows) {
						res.remove.rejects(new ShortStackError(`error removing ${type}`));
					} else {
						res.remove.resolves();
					}

					if (c === Docker.Container) {
						res.inspect.resolves(supervisorContainer);
					}

					resArray.push(res);
					return res as unknown as T;
				};
				dockerStub.getImage.returns(stub(Docker.Image, 'image'));
				dockerStub.getContainer.returns(stub(Docker.Container, 'container'));
				dockerStub.getVolume.returns(stub(Docker.Volume, 'volume'));
				dockerStub.getNetwork.returns(stub(Docker.Network, 'network'));
				return resArray;
			};

			afterEach(() => {
				dockerStub.getImage.resetHistory();
				dockerStub.getContainer.resetHistory();
				dockerStub.getVolume.resetHistory();
				dockerStub.getNetwork.resetHistory();
			});

			it('stores new snapshot on local mode enter', async () => {
				await localMode.handleLocalModeStateChange(true);

				const snapshot = await localMode.retrieveLatestSnapshot();
				expect(snapshot).to.be.not.null;
			});

			it('deletes newly created objects on local mode exit', async () => {
				const removeStubs = stubEngineObjectMethods(false);
				// All the objects returned by list<Objects> are not included into this snapshot.
				// Hence, removal should be called twice (stubbed methods return 2 objects per type).
				await storeCurrentSnapshot(
					['previous-container'],
					['previous-image'],
					['previous-volume'],
					['previous-network'],
				);

				await localMode.handleLocalModeStateChange(false);

				removeStubs.forEach((s) => expect(s.remove.calledTwice).to.be.true);
			});

			it('keeps objects from the previous snapshot on local mode exit', async () => {
				const removeStubs = stubEngineObjectMethods(false);
				// With this snapshot, only <object>-2 must be removed from the engine.
				await storeCurrentSnapshot(
					['container-1'],
					['image-1'],
					['volume-1'],
					['network-1'],
				);

				await localMode.handleLocalModeStateChange(false);

				expect(dockerStub.getImage.calledWithExactly('image-2')).to.be.true;
				expect(dockerStub.getContainer.calledWithExactly('container-2')).to.be
					.true;
				expect(dockerStub.getVolume.calledWithExactly('volume-2')).to.be.true;
				expect(dockerStub.getNetwork.calledWithExactly('network-2')).to.be.true;
				removeStubs.forEach((s) => expect(s.remove.calledOnce).to.be.true);
			});

			it('logs but consumes cleanup errors on local mode exit', async () => {
				const removeStubs = stubEngineObjectMethods(true);
				// This snapshot will cause the logic to remove everything.
				await storeCurrentSnapshot([], [], [], []);

				// This should not throw.
				await localMode.handleLocalModeStateChange(false);

				// Even though remove method throws, we still attempt all removals.
				removeStubs.forEach((s) => expect(s.remove.calledTwice).to.be.true);
			});

			it('skips cleanup without previous snapshot on local mode exit', async () => {
				const removeStubs = stubEngineObjectMethods(false);

				await localMode.handleLocalModeStateChange(false);

				expect(dockerStub.getImage.notCalled).to.be.true;
				expect(dockerStub.getContainer.notCalled).to.be.true;
				expect(dockerStub.getVolume.notCalled).to.be.true;
				expect(dockerStub.getNetwork.notCalled).to.be.true;
				removeStubs.forEach((s) => expect(s.remove.notCalled).to.be.true);
			});

			it('can be awaited', async () => {
				const removeStubs = stubEngineObjectMethods(false);
				await storeCurrentSnapshot([], [], [], []);

				// Run asynchronously (like on config change).
				localMode.startLocalModeChangeHandling(false);

				// Await like it's done by DeviceState.
				await localMode.switchCompletion();

				removeStubs.forEach((s) => expect(s.remove.calledTwice).to.be.true);
			});

			it('cleans the last snapshot so that nothing is done on restart', async () => {
				const removeStubs = stubEngineObjectMethods(false);
				await storeCurrentSnapshot([], [], [], []);

				await localMode.handleLocalModeStateChange(false);

				// The database should be empty now.
				expect(await recordsCount()).to.be.equal(0);

				// This has to be no ops.
				await localMode.handleLocalModeStateChange(false);
				// So our stubs must be called only once.
				// We delete 2 objects of each type during the first call, so number of getXXX and remove calls is 2.
				expect(dockerStub.getImage.callCount).to.be.equal(2);
				expect(dockerStub.getContainer.callCount).to.be.equal(3); // +1 for supervisor inspect call.
				expect(dockerStub.getVolume.callCount).to.be.equal(2);
				expect(dockerStub.getNetwork.callCount).to.be.equal(2);
				removeStubs.forEach((s) => expect(s.remove.callCount).to.be.equal(2));
			});

			it('skips cleanup in case of data corruption', async () => {
				const removeStubs = stubEngineObjectMethods(false);

				await db.models('engineSnapshot').insert({
					snapshot: 'bad json',
					timestamp: new Date().toISOString(),
				});

				localMode.startLocalModeChangeHandling(false);
				await localMode.switchCompletion();

				expect(dockerStub.getImage.notCalled).to.be.true;
				expect(dockerStub.getContainer.notCalled).to.be.true;
				expect(dockerStub.getVolume.notCalled).to.be.true;
				expect(dockerStub.getNetwork.notCalled).to.be.true;
				removeStubs.forEach((s) => expect(s.remove.notCalled).to.be.true);
			});

			describe('with supervisor being updated', () => {
				beforeEach(() => {
					// We make supervisor own resources to match currently listed objects.
					supervisorContainer.Id = 'container-1';
					supervisorContainer.Image = 'image-1';
					supervisorContainer.NetworkSettings.Networks['some-name'].NetworkID =
						'network-1';
					supervisorContainer.Mounts[0].Name = 'volume-1';
				});

				it('does not delete its own object', async () => {
					const removeStubs = stubEngineObjectMethods(false);
					// All the current engine objects will be new, including container-1 which is the supervisor.
					await storeCurrentSnapshot(
						['previous-container'],
						['previous-image'],
						['previous-volume'],
						['previous-network'],
					);

					await localMode.handleLocalModeStateChange(false);

					// Ensure we inspect our own container.
					const [, containerStub] = removeStubs;
					expect(containerStub.inspect.calledOnce).to.be.true;

					// Current engine objects include 2 entities of each type.
					// Container-1, network-1, image-1, and volume-1 are resources associated with currently running supervisor.
					// Only xxx-2 objects must be deleted.
					removeStubs.forEach((s) => expect(s.remove.calledOnce).to.be.true);
				});
			});
		});
	});

	describe('engine snapshot storage', () => {
		const recordSample = new EngineSnapshotRecord(
			new EngineSnapshot(
				['c1', 'c2'],
				['i1', 'i2'],
				['v1', 'v2'],
				['n1', 'n2'],
			),
			new Date(),
		);

		it('returns null when snapshot is not stored', async () => {
			expect(await recordsCount()).to.equal(0);
			const retrieved = await localMode.retrieveLatestSnapshot();
			expect(retrieved).to.be.null;
		});

		it('stores snapshot and retrieves from the db', async () => {
			await localMode.storeEngineSnapshot(recordSample);
			const retrieved = await localMode.retrieveLatestSnapshot();
			expect(retrieved).to.be.deep.equal(recordSample);
		});

		it('rewrites previous snapshot', async () => {
			await localMode.storeEngineSnapshot(recordSample);
			await localMode.storeEngineSnapshot(recordSample);
			await localMode.storeEngineSnapshot(recordSample);
			expect(await recordsCount()).to.equal(1);
		});

		describe('in case of data corruption', () => {
			beforeEach(async () => {
				await db.models('engineSnapshot').delete();
			});

			it('deals with snapshot data corruption', async () => {
				// Write bad data to simulate corruption.
				await db.models('engineSnapshot').insert({
					snapshot: 'bad json',
					timestamp: new Date().toISOString(),
				});

				try {
					const result = await localMode.retrieveLatestSnapshot();
					expect(result).to.not.exist;
				} catch (e: any) {
					expect(e.message).to.match(/Cannot parse snapshot data.*"bad json"/);
				}
			});

			it('deals with snapshot timestamp corruption', async () => {
				// Write bad data to simulate corruption.
				await db.models('engineSnapshot').insert({
					snapshot:
						'{"containers": [], "images": [], "volumes": [], "networks": []}',
					timestamp: 'bad timestamp',
				});

				try {
					const result = await localMode.retrieveLatestSnapshot();
					expect(result).to.not.exist;
				} catch (e: any) {
					expect(e.message).to.match(
						/Cannot parse snapshot data.*"bad timestamp"/,
					);
				}
			});
		});
	});
});
