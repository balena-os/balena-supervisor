// Adds a dockerImageId column to the image table to identify images downloaded with deltas
exports.up = function (knex) {
	return knex.schema.table('image', (t) => {
		t.string('dockerImageId');
	});
};

exports.down = function () {
	return Promise.reject(new Error('Not implemented'));
};
