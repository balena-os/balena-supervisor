// Only used to be able to run "knex migrate:make <migration name>" on the development machine.
// Not used in the supervisor.

module.exports = {
	client: 'sqlite3',
	connection: {
		filename: './database.sqlite'
	},
	useNullAsDefault: true,
	migrations: {
		directory: './src/migrations'
	}
}
