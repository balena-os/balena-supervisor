fs = require('fs')

module.exports = ->
	try
		fs.unlinkSync(process.env.DATABASE_PATH)

	try
		fs.unlinkSync(process.env.DATABASE_PATH_2)

	try
		fs.unlinkSync(process.env.DATABASE_PATH_3)

	try
		fs.unlinkSync(process.env.LED_FILE)

	try
		fs.writeFileSync('./test/data/config.json', fs.readFileSync('./test/data/testconfig.json'))
		fs.writeFileSync('./test/data/config-apibinder.json', fs.readFileSync('./test/data/testconfig-apibinder.json'))

		fs.writeFileSync(
			'./test/data/config-apibinder-offline.json',
			fs.readFileSync('./test/data/testconfig-apibinder-offline.json')
		)
		fs.writeFileSync(
			'./test/data/config-apibinder-offline2.json',
			fs.readFileSync('./test/data/testconfig-apibinder-offline2.json')
		)
