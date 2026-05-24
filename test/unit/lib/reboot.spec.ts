import { expect } from 'chai';

import { requiresActivationReboot } from '~/lib/reboot';

describe('lib/reboot', () => {
	describe('requiresActivationReboot', () => {
		const bootTime = new Date('2026-05-24T10:00:00Z');
		const afterBoot = new Date('2026-05-24T10:05:00Z');
		const beforeBoot = new Date('2026-05-24T09:55:00Z');
		const rebootLabel = { 'io.balena.update.requires-reboot': '1' };

		it('is true when label is truthy and createdAt is after bootTime', () => {
			expect(requiresActivationReboot(rebootLabel, afterBoot, bootTime)).to.be
				.true;
		});

		it('is false when the reboot label is absent', () => {
			expect(requiresActivationReboot({}, afterBoot, bootTime)).to.be.false;
		});

		it('is false when the reboot label is falsy', () => {
			expect(
				requiresActivationReboot(
					{ 'io.balena.update.requires-reboot': '0' },
					afterBoot,
					bootTime,
				),
			).to.be.false;
		});

		it('is false when createdAt is null', () => {
			expect(requiresActivationReboot(rebootLabel, null, bootTime)).to.be.false;
		});

		it('is false when createdAt is before bootTime (already rebooted)', () => {
			expect(requiresActivationReboot(rebootLabel, beforeBoot, bootTime)).to.be
				.false;
		});

		it('accepts "true" as a truthy label value', () => {
			expect(
				requiresActivationReboot(
					{ 'io.balena.update.requires-reboot': 'true' },
					afterBoot,
					bootTime,
				),
			).to.be.true;
		});

		it('is false when createdAt equals bootTime (not strictly after)', () => {
			expect(requiresActivationReboot(rebootLabel, bootTime, bootTime)).to.be
				.false;
		});

		it('accepts "on" as a truthy label value', () => {
			expect(
				requiresActivationReboot(
					{ 'io.balena.update.requires-reboot': 'on' },
					afterBoot,
					bootTime,
				),
			).to.be.true;
		});
	});
});
