import { expect } from 'chai';
import * as deviceState from '~/src/device-state';

describe('usingInferStepsLock', () => {
	it('should not allow to start a function call without finishing the previous sequential call of the function', async () => {
		const result: string[] = [];
		const fn = async (id: number, str: string) => {
			return deviceState.usingInferStepsLock(async () => {
				if (id < 3 || id === 20) {
					result.push(`Started ${id}, ${str} call`);
					await fn(id + 1, 'first');
					await fn(id + 1, 'second');
					result.push(`Finished ${id}, ${str} call`);
				}
			});
		};
		await fn(1, 'master');
		await fn(20, 'master');
		expect(result).to.deep.equal([
			'Started 1, master call',
			'Started 2, first call',
			'Finished 2, first call',
			'Started 2, second call',
			'Finished 2, second call',
			'Finished 1, master call',
			'Started 20, master call',
			'Finished 20, master call',
		]);
	});
});
