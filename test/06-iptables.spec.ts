import * as Bluebird from 'bluebird';
import { stub } from 'sinon';
import { expect } from './lib/chai-config';

import * as iptables from '../src/lib/iptables';

describe('iptables', async () => {
	it('calls iptables to delete and recreate rules to block a port', async () => {
		stub(iptables, 'execAsync').returns(Bluebird.resolve(''));

		await iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42);
		expect((iptables.execAsync as sinon.SinonStub).callCount).to.equal(12);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -A INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -A INPUT -p tcp --dport 42 -j REJECT',
		);
		(iptables.execAsync as sinon.SinonStub).restore();
	});

	it("falls back to blocking the port with DROP if there's no REJECT support", async () => {
		stub(iptables, 'execAsync').callsFake(cmd => {
			if (/REJECT$/.test(cmd)) {
				return Bluebird.reject(new Error());
			} else {
				return Bluebird.resolve('');
			}
		});

		await iptables.rejectOnAllInterfacesExcept(['foo', 'bar'], 42);
		expect((iptables.execAsync as sinon.SinonStub).callCount).to.equal(16);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -A INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -D INPUT -p tcp --dport 42 -j DROP',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'iptables -A INPUT -p tcp --dport 42 -j DROP',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -I INPUT -p tcp --dport 42 -i foo -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -I INPUT -p tcp --dport 42 -i bar -j ACCEPT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -A INPUT -p tcp --dport 42 -j REJECT',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -D INPUT -p tcp --dport 42 -j DROP',
		);
		expect(iptables.execAsync).to.be.calledWith(
			'ip6tables -A INPUT -p tcp --dport 42 -j DROP',
		);

		(iptables.execAsync as sinon.SinonStub).restore();
	});
});
