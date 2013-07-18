fs = require('fs')
async = require('async')
request = require('request')
{exec} = require('child_process')

API_ENDPOINT = 'http://paras.rulemotion.com:1337'

try
	state = require('./state.json')
catch e
	console.error(e)
	process.exit()

bootstrapTasks = [
	# get config from extra partition
	(callback) ->
		try
			callback(null, require('/mnt/config.json'))
		catch error
			callback(error)
	# bootstraping
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

			fs.writeFileSync('state.json', JSON.stringify(state))

			fs.writeFileSync('/etc/openvpn/ca.crt', body.ca)
			fs.writeFileSync('/etc/openvpn/client.crt', body.cert)
			fs.writeFileSync('/etc/openvpn/client.key', body.key)
			fs.appendFileSync('/etc/openvpn/client.conf', "remote #{body.vpnhost} #{body.vpnport}")

			callback(null)
		)
]

stage1Tasks = [
	(callback) -> async.waterfall(bootstrapTasks, callback)
	(callback) -> exec('systemctl start openvpn@client', callback)
	(callback) -> exec('systemctl enable openvpn@client', callback)
]

async.series(stage1Tasks, ->
	console.log('Bootstrapped')
)
