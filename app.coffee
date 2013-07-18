fs = require('fs')
async = require('async')
request = require('request')
getuid = require('getuid')
{exec} = require('child_process')

API_ENDPOINT = 'http://paras.rulemotion.com:1337'
HAKI_PATH = '/home/haki'

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
			json:
				user: config.id
		}, (error, response, body) ->
			if error
				return callback(error)

			if typeof body isnt 'object'
				callback(body)

			state.virgin = false
			state.uuid = body.uuid
			state.giturl = body.giturl

			console.log state

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
	(callback) ->
		process.setuid(getuid('haki'))
		process.chdir(HAKI_PATH)
		fs.mkdir('hakiapp', callback)
	(callback) -> exec('git init', cwd: 'hakiapp', callback)
	(callback) -> exec("git remote add origin #{state.giturl}", cwd: 'hakiapp', callback)
]

stage2Tasks = [
	(callback) ->
		process.setuid(getuid('haki'))
		process.chdir(HAKI_PATH)
		fs.mkdir('hakiapp', callback)
	(callback) -> async.forever([
		(callback) -> exec('git pull', cwd: 'hakiapp', callback)
		(callback) -> exec('npm install', cwd: 'hakiapp', callback)
		(callback) -> exec('foreman start', cwd: 'hakiapp', callback)
	])
]


if state.virgin
	async.series(stage1Tasks, (error, results) ->
		if (error)
			console.error(error)
		else
			console.log('Bootstrapped')
	)
