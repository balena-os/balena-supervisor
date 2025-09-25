import type { PortRange } from '~/src/compose/ports';
import { PortMap } from '~/src/compose/ports';
import { expect } from 'chai';

import portBindings from '~/test-data/ports/not-ascending/port-bindings.json';
import compose from '~/test-data/ports/not-ascending/compose.json';

// Force cast `PortMap` as a public version so we can test it
const PortMapPublic = PortMap as any as new (
	portStrOrObj: string | PortRange,
) => PortMap;

describe('compose/ports', function () {
	describe('Port string parsing', function () {
		it('should correctly parse a port string without a range', function () {
			expect(new PortMapPublic('80')).to.deep.equal(
				new PortMapPublic({
					internalStart: 80,
					internalEnd: 80,
					externalStart: 80,
					externalEnd: 80,
					protocol: 'tcp',
					host: '',
				}),
			);

			expect(new PortMapPublic('80:80')).to.deep.equal(
				new PortMapPublic({
					internalStart: 80,
					internalEnd: 80,
					externalStart: 80,
					externalEnd: 80,
					protocol: 'tcp',
					host: '',
				}),
			);
		});

		it('should correctly parse a port string without an external range', () =>
			expect(new PortMapPublic('80-90')).to.deep.equal(
				new PortMapPublic({
					internalStart: 80,
					internalEnd: 90,
					externalStart: 80,
					externalEnd: 90,
					protocol: 'tcp',
					host: '',
				}),
			));

		it('should correctly parse a port string with a range', () =>
			expect(new PortMapPublic('80-100:100-120')).to.deep.equal(
				new PortMapPublic({
					internalStart: 100,
					internalEnd: 120,
					externalStart: 80,
					externalEnd: 100,
					protocol: 'tcp',
					host: '',
				}),
			));

		it('should correctly parse a protocol', function () {
			expect(new PortMapPublic('80/udp')).to.deep.equal(
				new PortMapPublic({
					internalStart: 80,
					internalEnd: 80,
					externalStart: 80,
					externalEnd: 80,
					protocol: 'udp',
					host: '',
				}),
			);

			expect(new PortMapPublic('80:80/udp')).to.deep.equal(
				new PortMapPublic({
					internalStart: 80,
					internalEnd: 80,
					externalStart: 80,
					externalEnd: 80,
					protocol: 'udp',
					host: '',
				}),
			);

			expect(new PortMapPublic('80-90:100-110/udp')).to.deep.equal(
				new PortMapPublic({
					internalStart: 100,
					internalEnd: 110,
					externalStart: 80,
					externalEnd: 90,
					protocol: 'udp',
					host: '',
				}),
			);
		});

		it('should throw when the port string is incorrect', () =>
			expect(() => new PortMapPublic('80-90:80-85')).to.throw);
	});

	describe('toDockerOpts', function () {
		it('should correctly generate docker options', () =>
			expect(new PortMapPublic('80').toDockerOpts()).to.deep.equal({
				exposedPorts: {
					'80/tcp': {},
				},
				portBindings: {
					'80/tcp': [{ HostIp: '', HostPort: '80' }],
				},
			}));

		it('should correctly generate docker options for a port range', () =>
			expect(new PortMapPublic('80-85').toDockerOpts()).to.deep.equal({
				exposedPorts: {
					'80/tcp': {},
					'81/tcp': {},
					'82/tcp': {},
					'83/tcp': {},
					'84/tcp': {},
					'85/tcp': {},
				},
				portBindings: {
					'80/tcp': [{ HostIp: '', HostPort: '80' }],
					'81/tcp': [{ HostIp: '', HostPort: '81' }],
					'82/tcp': [{ HostIp: '', HostPort: '82' }],
					'83/tcp': [{ HostIp: '', HostPort: '83' }],
					'84/tcp': [{ HostIp: '', HostPort: '84' }],
					'85/tcp': [{ HostIp: '', HostPort: '85' }],
				},
			}));
	});

	describe('fromDockerOpts', function () {
		it('should correctly detect a port range', () =>
			expect(
				PortMap.fromDockerOpts({
					'100/tcp': [{ HostIp: '123', HostPort: '200' }],
					'101/tcp': [{ HostIp: '123', HostPort: '201' }],
					'102/tcp': [{ HostIp: '123', HostPort: '202' }],
				}),
			).to.deep.equal([
				new PortMapPublic({
					internalStart: 100,
					internalEnd: 102,
					externalStart: 200,
					externalEnd: 202,
					protocol: 'tcp',
					host: '123',
				}),
			]));

		it('should correctly split ports into ranges', () =>
			expect(
				PortMap.fromDockerOpts({
					'100/tcp': [{ HostIp: '123', HostPort: '200' }],
					'101/tcp': [{ HostIp: '123', HostPort: '201' }],
					'105/tcp': [{ HostIp: '123', HostPort: '205' }],
					'106/tcp': [{ HostIp: '123', HostPort: '206' }],
					'110/tcp': [{ HostIp: '123', HostPort: '210' }],
				}),
			).to.deep.equal([
				new PortMapPublic({
					internalStart: 100,
					internalEnd: 101,
					externalStart: 200,
					externalEnd: 201,
					protocol: 'tcp',
					host: '123',
				}),
				new PortMapPublic({
					internalStart: 105,
					internalEnd: 106,
					externalStart: 205,
					externalEnd: 206,
					protocol: 'tcp',
					host: '123',
				}),
				new PortMapPublic({
					internalStart: 110,
					internalEnd: 110,
					externalStart: 210,
					externalEnd: 210,
					protocol: 'tcp',
					host: '123',
				}),
			]));

		it('should correctly consider internal and external ports', () =>
			expect(
				PortMap.fromDockerOpts({
					'100/tcp': [{ HostIp: '123', HostPort: '200' }],
					'101/tcp': [{ HostIp: '123', HostPort: '101' }],
					'102/tcp': [{ HostIp: '123', HostPort: '202' }],
				}),
			).to.deep.equal([
				new PortMapPublic({
					internalStart: 100,
					internalEnd: 100,
					externalStart: 200,
					externalEnd: 200,
					protocol: 'tcp',
					host: '123',
				}),
				new PortMapPublic({
					internalStart: 101,
					internalEnd: 101,
					externalStart: 101,
					externalEnd: 101,
					protocol: 'tcp',
					host: '123',
				}),
				new PortMapPublic({
					internalStart: 102,
					internalEnd: 102,
					externalStart: 202,
					externalEnd: 202,
					protocol: 'tcp',
					host: '123',
				}),
			]));

		it('should consider the host when generating ranges', () =>
			expect(
				PortMap.fromDockerOpts({
					'100/tcp': [{ HostIp: '123', HostPort: '200' }],
					'101/tcp': [{ HostIp: '456', HostPort: '201' }],
					'102/tcp': [{ HostIp: '456', HostPort: '202' }],
				}),
			).to.deep.equal([
				new PortMapPublic({
					internalStart: 100,
					internalEnd: 100,
					externalStart: 200,
					externalEnd: 200,
					protocol: 'tcp',
					host: '123',
				}),
				new PortMapPublic({
					internalStart: 101,
					internalEnd: 102,
					externalStart: 201,
					externalEnd: 202,
					protocol: 'tcp',
					host: '456',
				}),
			]));

		it('should consider the protocol when generating ranges', () =>
			expect(
				PortMap.fromDockerOpts({
					'100/tcp': [{ HostIp: '123', HostPort: '200' }],
					'101/udp': [{ HostIp: '123', HostPort: '201' }],
					'102/udp': [{ HostIp: '123', HostPort: '202' }],
				}),
			).to.deep.equal([
				new PortMapPublic({
					internalStart: 100,
					internalEnd: 100,
					externalStart: 200,
					externalEnd: 200,
					protocol: 'tcp',
					host: '123',
				}),
				new PortMapPublic({
					internalStart: 101,
					internalEnd: 102,
					externalStart: 201,
					externalEnd: 202,
					protocol: 'udp',
					host: '123',
				}),
			]));

		it('should correctly detect multiple hosts ports on an internal port', () =>
			expect(
				PortMap.fromDockerOpts({
					'100/tcp': [
						{ HostIp: '123', HostPort: '200' },
						{ HostIp: '123', HostPort: '201' },
					],
				}),
			).to.deep.equal([
				new PortMapPublic({
					internalStart: 100,
					internalEnd: 100,
					externalStart: 200,
					externalEnd: 200,
					protocol: 'tcp',
					host: '123',
				}),
				new PortMapPublic({
					internalStart: 100,
					internalEnd: 100,
					externalStart: 201,
					externalEnd: 201,
					protocol: 'tcp',
					host: '123',
				}),
			]));
	});

	describe('Running container comparison', () =>
		it('should not consider order when comparing current and target state', function () {
			const portMapsCurrent = PortMap.fromDockerOpts(portBindings);
			const portMapsTarget = PortMap.fromComposePorts(compose.ports);

			expect(portMapsTarget).to.deep.equal(portMapsCurrent);
		}));

	describe('fromComposePorts', () =>
		it('should normalise compose ports', () =>
			expect(
				PortMap.fromComposePorts(['80:80', '81:81', '82:82']),
			).to.deep.equal([new PortMapPublic('80-82')])));

	describe('normalisePortMaps', function () {
		it('should correctly normalise PortMap lists', function () {
			expect(
				PortMap.normalisePortMaps([
					new PortMapPublic('80:90'),
					new PortMapPublic('81:91'),
				]),
			).to.deep.equal([new PortMapPublic('80-81:90-91')]);

			expect(
				PortMap.normalisePortMaps([
					new PortMapPublic('80:90'),
					new PortMapPublic('81:91'),
					new PortMapPublic('82:92'),
					new PortMapPublic('83:93'),
					new PortMapPublic('84:94'),
					new PortMapPublic('85:95'),
					new PortMapPublic('86:96'),
					new PortMapPublic('87:97'),
					new PortMapPublic('88:98'),
					new PortMapPublic('89:99'),
					new PortMapPublic('90:100'),
				]),
			).to.deep.equal([new PortMapPublic('80-90:90-100')]);

			expect(PortMap.normalisePortMaps([])).to.deep.equal([]);
		});

		it('should correctly consider protocols', function () {
			expect(
				PortMap.normalisePortMaps([
					new PortMapPublic('80:90'),
					new PortMapPublic('81:91/udp'),
				]),
			).to.deep.equal([
				new PortMapPublic('80:90'),
				new PortMapPublic('81:91/udp'),
			]);

			expect(
				PortMap.normalisePortMaps([
					new PortMapPublic('80:90'),
					new PortMapPublic('100:110/udp'),
					new PortMapPublic('81:91'),
				]),
			).to.deep.equal([
				new PortMapPublic('80-81:90-91'),
				new PortMapPublic('100:110/udp'),
			]);

			// This shouldn't ever be provided, but it shows the algorithm
			// working properly
			expect(
				PortMap.normalisePortMaps([
					new PortMapPublic('80:90'),
					new PortMapPublic('81:91/udp'),
					new PortMapPublic('81:91'),
				]),
			).to.deep.equal([
				new PortMapPublic('80-81:90-91'),
				new PortMapPublic('81:91/udp'),
			]);
		});

		it('should correctly consider hosts', function () {
			expect(
				PortMap.normalisePortMaps([
					new PortMapPublic('127.0.0.1:80:80'),
					new PortMapPublic('81:81'),
				]),
			).to.deep.equal([
				new PortMapPublic('127.0.0.1:80:80'),
				new PortMapPublic('81:81'),
			]);

			expect(
				PortMap.normalisePortMaps([
					new PortMapPublic('127.0.0.1:80:80'),
					new PortMapPublic('127.0.0.1:81:81'),
				]),
			).to.deep.equal([new PortMapPublic('127.0.0.1:80-81:80-81')]);
		});
	});
});
