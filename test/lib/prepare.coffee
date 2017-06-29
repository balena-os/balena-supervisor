fs = require('fs')

module.exports = ->
	try
		fs.unlinkSync(process.env.DATABASE_PATH)

	try
		fs.unlinkSync(process.env.DATABASE_PATH_2)

	try
		fs.writeFileSync('./test/data/config.json', fs.readFileSync('./test/data/testconfig.json'))
