
exports.up = function (knex, Promise) {
	let addColumn = (table, type, column) => {
		return knex.schema.table(table, (t) => { return t[type](column) })
	}
	let dropColumn = (table, column) => {
		return knex.schema.table(table, (t) => { return t.dropColumn(column) })
	}

	return knex('app').select()
		.tap((apps) => {
			if (apps.length > 0) {
				return knex('config').insert({ key: 'legacyAppsPresent', value: 'true' })
			}
		})
		.then((apps) => {
			
		})
}

exports.down = function(knex, Promise) {
	return Promise.try(() => { throw new Error('Not implemented') })
}