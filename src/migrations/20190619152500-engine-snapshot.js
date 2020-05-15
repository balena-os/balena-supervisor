exports.up = (knex) => {
	return knex.schema.createTable('engineSnapshot', (t) => {
		t.string('snapshot'); // Engine snapshot encoded as JSON.
		t.string('timestamp'); // When the snapshot was created.
	});
};

exports.down = () => {
	return Promise.reject(new Error('Not Implemented'));
};
