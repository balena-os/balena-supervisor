fs = require('fs')
async = require('async')
request = require('request')
{exec} = require('child_process')

API_ENDPOINT = 'http://paras.rulemotion.com:1337'
HOME_PATH = '/home/haki'

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
	# bootstrapping
	(config, callback) ->
		request.post("#{API_ENDPOINT}/associate", {
			user: config.id
		}, (error, response, body) ->
			if error
				return callback(error)

			try
				if typeof body isnt 'object'
					throw new Error(body)

				body = JSON.parse(body)
			catch error
				callback(error)

			state.virgin = false
			state.uuid = body.uuid
			state.giturl = body.giturl

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

stage2Tasks = [
	(callback) -> process.chdir("#{HOME_PATH}/hakiapp")
	(callback) -> exec('npm install', callback)
	(callback) -> exec('foreman start', callback)
]

async.series(stage1Tasks, ->
	console.log('Bootstrapped')

	async.doUntil(
		-> fs.existsSync('hakiapp')
		(callback) ->
			process.chdir(HOME_PATH)
			console.log('git clone')
			exec("git clone #{state.giturl}")
			setTimeout(callback, 1000)
		(error) ->
			if error?
				console.error(error)
			else
				console.log('Initialized')
	)
