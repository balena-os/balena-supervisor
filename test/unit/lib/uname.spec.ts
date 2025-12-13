import { expect } from 'chai';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import * as uname from '~/lib/uname';
import log from '~/lib/supervisor-console';

describe('lib/uname', () => {
	let unameGetStub: SinonStub;

	describe('getKernelSlug', () => {
		beforeEach(() => {
			unameGetStub = stub(uname, 'get');
		});
		afterEach(() => {
			unameGetStub.restore();
		});

		it('should return lowercase kernel name', async () => {
			for (const kernel of ['Linux', 'FreeBSD', 'Darwin']) {
				unameGetStub.resolves(kernel);
				expect(await uname.getKernelSlug()).to.equal(kernel.toLowerCase());
				expect(unameGetStub).to.have.been.calledWith('-s');
			}
		});
	});

	describe('getKernelVersion', () => {
		beforeEach(() => {
			unameGetStub = stub(uname, 'get');
		});

		afterEach(() => {
			unameGetStub.restore();
		});

		it('should correctly parse kernel version strings', async () => {
			unameGetStub.resolves('5.15.150-yocto-standard');
			expect(await uname.getKernelVersion()).to.equal('5.15.150');
			expect(unameGetStub).to.have.been.calledWith('-r');
		});

		it('should parse kernel version from L4T string', async () => {
			unameGetStub.resolves('4.9.140-l4t-r32.2+g3dcbed5');
			expect(await uname.getKernelVersion()).to.equal('4.9.140');
			expect(unameGetStub).to.have.been.calledWith('-r');
		});

		it('should handle kernel versions with various suffixes', async () => {
			unameGetStub.resolves('6.1.0-rpi7-rpi-v8');
			expect(await uname.getKernelVersion()).to.equal('6.1.0');
			expect(unameGetStub).to.have.been.calledWith('-r');
		});

		it('should return undefined when version format is unexpected', async () => {
			unameGetStub.resolves('invalid-kernel-string');
			expect(await uname.getKernelVersion()).to.be.undefined;
			expect(unameGetStub).to.have.been.calledWith('-r');
		});

		it('should return undefined and log error when exec fails', async () => {
			unameGetStub.rejects(new uname.UnameError('exec failed bar'));
			expect(await uname.getKernelVersion()).to.be.undefined;
			expect(log.error as sinon.SinonStub).to.have.been.calledWith(
				'Could not detect kernel version! Error: exec failed bar',
			);
		});
	});

	describe('getL4tVersion', () => {
		beforeEach(() => {
			unameGetStub = stub(uname, 'get');
		});

		afterEach(() => {
			unameGetStub.restore();
		});

		it('should correctly parse L4T version strings with two numbers', async () => {
			unameGetStub.resolves('4.9.140-l4t-r32.2+g3dcbed5');
			expect(await uname.getL4tVersion()).to.equal('32.2.0');
			expect(unameGetStub).to.have.been.calledWith('-r');
			unameGetStub.reset();

			unameGetStub.resolves('4.4.38-l4t-r28.2+g174510d');
			expect(await uname.getL4tVersion()).to.equal('28.2.0');
			expect(unameGetStub).to.have.been.calledWith('-r');
		});

		it('should correctly handle L4T versions with three numbers', async () => {
			unameGetStub.resolves('4.4.38-l4t-r32.3.1+g174510d');
			expect(await uname.getL4tVersion()).to.equal('32.3.1');
			expect(unameGetStub).to.have.been.calledWith('-r');
		});

		it('should return undefined when there is no L4T string in uname', async () => {
			unameGetStub.resolves('4.18.14-yocto-standard');
			expect(await uname.getL4tVersion()).to.be.undefined;
			expect(unameGetStub).to.have.been.calledWith('-r');
		});

		it('should return undefined and log error when exec fails', async () => {
			unameGetStub.rejects(new uname.UnameError('exec failed foo'));
			expect(await uname.getL4tVersion()).to.be.undefined;
			expect(log.error as sinon.SinonStub).to.have.been.calledWith(
				'Could not detect l4t version! Error: exec failed foo',
			);
		});
	});
});
