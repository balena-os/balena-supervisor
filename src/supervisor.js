process.on('uncaughtException', function (e) {
	console.log('Got unhandled exception', e)
})

var knex = require('./db')

// Wait for the DB schema to be created
knex.init.then(function () {
	require('./app');
})
