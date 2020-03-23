// Adds a dockerImageId column to the image table to identify images downloaded with deltas
exports.up = function(knex, Promise) {
	return knex.schema.table('image', t => {
		t.string('dockerImageId');
	});
};

exports.down = function(knex, Promise) {
	return Promise.reject(new Error('Not implemented'));
};
