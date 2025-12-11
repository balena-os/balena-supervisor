import { expect } from 'chai';
import * as uname from '~/lib/uname';

describe('lib/uname', () => {
	describe('parseKernelSlug', () => {
		it('should return lowercase kernel name', () => {
			for (const kernel of ['Linux', 'FreeBSD', 'Darwin']) {
				expect(uname.parseKernelSlug(kernel)).to.equal(kernel.toLowerCase());
			}
		});
	});

	describe('parseKernelVersion', () => {
		it('should correctly parse kernel version strings', () => {
			expect(uname.parseKernelVersion('5.15.150-yocto-standard')).to.equal(
				'5.15.150',
			);
		});

		it('should parse kernel version from L4T string', () => {
			expect(uname.parseKernelVersion('4.9.140-l4t-r32.2+g3dcbed5')).to.equal(
				'4.9.140',
			);
		});

		it('should handle kernel versions with various suffixes', () => {
			expect(uname.parseKernelVersion('6.1.0-rpi7-rpi-v8')).to.equal('6.1.0');
		});

		it('should return undefined when version format is unexpected', () => {
			expect(uname.parseKernelVersion('invalid-kernel-string')).to.be.undefined;
		});
	});

	describe('parseL4tVersion', () => {
		it('should correctly parse L4T version strings with two numbers', () => {
			expect(uname.parseL4tVersion('4.9.140-l4t-r32.2+g3dcbed5')).to.equal(
				'32.2.0',
			);
			expect(uname.parseL4tVersion('4.4.38-l4t-r28.2+g174510d')).to.equal(
				'28.2.0',
			);
		});

		it('should correctly handle L4T versions with three numbers', () => {
			expect(uname.parseL4tVersion('4.4.38-l4t-r32.3.1+g174510d')).to.equal(
				'32.3.1',
			);
		});

		it('should return undefined when there is no L4T string in uname', () => {
			expect(uname.parseL4tVersion('4.18.14-yocto-standard')).to.be.undefined;
		});
	});
});
