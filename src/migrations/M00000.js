import _ from 'lodash';

// We take legacy deviceConfig targets and store them without the RESIN_ prefix
// (we also strip the BALENA_ prefix for completeness, even though no supervisors
// using this prefix made it to production)
export async function up(knex) {
	const devConfigs = await knex('deviceConfig').select('targetValues');
	const devConfig = devConfigs[0];
	const targetValues = JSON.parse(devConfig.targetValues);
	const filteredTargetValues = _.mapKeys(targetValues, (_v, k) => {
		return k.replace(/^(?:RESIN|BALENA)_(.*)/, '$1');
	});
	await knex('deviceConfig').update({
		targetValues: JSON.stringify(filteredTargetValues),
	});
}

export function down() {
	throw new Error('Not implemented');
}
