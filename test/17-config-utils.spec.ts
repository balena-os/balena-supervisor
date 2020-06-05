import { expect } from './lib/chai-config';
import { stub } from 'sinon';
import { fs } from 'mz';
import * as configUtils from '../src/config/utils';
import { ExtlinuxConfigBackend, RPiConfigBackend } from '../src/config/backend';

const extlinuxBackend = new ExtlinuxConfigBackend();
const rpiBackend = new RPiConfigBackend();

describe('Config Utilities', () =>
	describe('Boot config utilities', function () {
		describe('Env <-> Config', () =>
			it('correctly transforms environments to boot config objects', function () {
				const bootConfig = configUtils.envToBootConfig(rpiBackend, {
					HOST_CONFIG_initramfs: 'initramf.gz 0x00800000',
					HOST_CONFIG_dtparam: '"i2c=on","audio=on"',
					HOST_CONFIG_dtoverlay:
						'"ads7846","lirc-rpi,gpio_out_pin=17,gpio_in_pin=13"',
					HOST_CONFIG_foobar: 'baz',
				});
				expect(bootConfig).to.deep.equal({
					initramfs: 'initramf.gz 0x00800000',
					dtparam: ['i2c=on', 'audio=on'],
					dtoverlay: ['ads7846', 'lirc-rpi,gpio_out_pin=17,gpio_in_pin=13'],
					foobar: 'baz',
				});
			}));

		describe('TX2 boot config utilities', function () {
			it('should parse a extlinux.conf file', function () {
				const text = `\
DEFAULT primary
# Comment
TIMEOUT 30

MENU TITLE Boot Options
LABEL primary
MENU LABEL primary Image
LINUX /Image
APPEND \${cbootargs} \${resin_kernel_root} ro rootwait\
`;

				// @ts-ignore accessing private method
				const parsed = ExtlinuxConfigBackend.parseExtlinuxFile(text);
				expect(parsed.globals)
					.to.have.property('DEFAULT')
					.that.equals('primary');
				expect(parsed.globals).to.have.property('TIMEOUT').that.equals('30');
				expect(parsed.globals)
					.to.have.property('MENU TITLE')
					.that.equals('Boot Options');

				expect(parsed.labels).to.have.property('primary');
				const { primary } = parsed.labels;
				expect(primary)
					.to.have.property('MENU LABEL')
					.that.equals('primary Image');
				expect(primary).to.have.property('LINUX').that.equals('/Image');
				expect(primary)
					.to.have.property('APPEND')
					.that.equals('${cbootargs} ${resin_kernel_root} ro rootwait');
			});

			it('should parse multiple service entries', function () {
				const text = `\
DEFAULT primary
# Comment
TIMEOUT 30

MENU TITLE Boot Options
LABEL primary
LINUX test1
APPEND test2
LABEL secondary
LINUX test3
APPEND test4\
`;

				// @ts-ignore accessing private method
				const parsed = ExtlinuxConfigBackend.parseExtlinuxFile(text);
				expect(parsed.labels).to.have.property('primary').that.deep.equals({
					LINUX: 'test1',
					APPEND: 'test2',
				});
				expect(parsed.labels).to.have.property('secondary').that.deep.equals({
					LINUX: 'test3',
					APPEND: 'test4',
				});
			});

			it('should parse configuration options from an extlinux.conf file', function () {
				let text = `\
DEFAULT primary
# Comment
TIMEOUT 30

MENU TITLE Boot Options
LABEL primary
MENU LABEL primary Image
LINUX /Image
APPEND \${cbootargs} \${resin_kernel_root} ro rootwait isolcpus=3\
`;

				let readFileStub = stub(fs, 'readFile').resolves(text);
				let parsed = extlinuxBackend.getBootConfig();

				expect(parsed).to.eventually.have.property('isolcpus').that.equals('3');
				readFileStub.restore();

				text = `\
DEFAULT primary
# Comment
TIMEOUT 30

MENU TITLE Boot Options
LABEL primary
MENU LABEL primary Image
LINUX /Image
APPEND \${cbootargs} \${resin_kernel_root} ro rootwait isolcpus=3,4,5\
`;
				readFileStub = stub(fs, 'readFile').resolves(text);

				parsed = extlinuxBackend.getBootConfig();

				readFileStub.restore();

				expect(parsed)
					.to.eventually.have.property('isolcpus')
					.that.equals('3,4,5');
			});
		});
	}));
