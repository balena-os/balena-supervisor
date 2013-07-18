fs = require('fs')
async = require('async')
request = require('request')

API_ENDPOINT = 'http://paras.rulemotion.com:1337'


try
	state = require('state.json')
catch e
	console.error(e)
	process.exit()

bootstrapTasks = [
	(callback) ->
		try
			callback(null, require('/mnt/config.json'))
		catch error
			callback(error)
	(config, callback) ->
		request.post("#{API_ENDPOINT}/associate", {
			user: config.id
		}, (error, response, body) ->
			if error
				return callback(error)

			try
				body = JSON.parse(body)
			catch error
				callback(error)
			
			state.virgin = false
			state.uuid = body.uuid

			fs.writeFileSync('state.json', JSON.strigify(state))
			


			callback(null)
		)
]
