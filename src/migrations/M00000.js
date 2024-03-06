import _ from 'lodash';

// We take legacy deviceConfig targets and store them without the RESIN_ prefix
// (we also strip the BALENA_ prefix for completeness, even though no supervisors
// using this prefix made it to production)
exports.up = function (knex) {
	return knex('deviceConfig')
		.select('targetValues')
		.then((devConfigs) => {
			const devConfig = devConfigs[0];
			const targetValues = JSON.parse(devConfig.targetValues);
			const filteredTargetValues = _.mapKeys(targetValues, (_v, k) => {
				return k.replace(/^(?:RESIN|BALENA)_(.*)/, '$1');
			});
			return knex('deviceConfig').update({
				targetValues: JSON.stringify(filteredTargetValues),
			});
		});
};

exports.down = function () {
	return Promise.reject(new Error('Not Implemented'));
};
