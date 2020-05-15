exports.up = function (knex) {
	return knex('deviceConfig')
		.select('targetValues')
		.then(([target]) => {
			const targetValues = target.targetValues;
			const jsonValues = JSON.parse(targetValues);

			if (jsonValues['SUPERVISOR_DELTA_APPLY_TIMEOUT'] === '') {
				jsonValues['SUPERVISOR_DELTA_APPLY_TIMEOUT'] = '0';

				// Only update the database if we need to
				return knex('deviceConfig').update({
					targetValues: JSON.stringify(jsonValues),
				});
			}
		});
};

exports.down = function () {
	return Promise.reject(new Error('Not Implemented'));
};
