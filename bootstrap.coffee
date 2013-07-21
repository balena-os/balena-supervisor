settings = require('./settings')
state = require('./state')
{exec} = require('child_process')
async = require('async')
request = require('request')
fs = require('fs')

bootstrapTasks = [
	# get config from extra partition
	(callback) ->
		console.log('Reading the user conf file')
		try
			callback(null, require('/mnt/config.json'))
		catch error
			callback(error)
	# bootstrapping
	(config, callback) ->
		console.log('Got user', config.username)
		console.log('Posting to the API')
		request.post("#{settings.API_ENDPOINT}/associate", {
			json:
				user: config.id
		}, (error, response, body) ->
			if error or response.statusCode is 404
				return callback('Error associating with user')

			state.set('virgin', false)
			state.set('uuid', body.uuid)
			state.set('gitUrl', body.gitUrl)

			vpnConf = fs.readFileSync('/etc/openvpn/client.conf.template', 'utf8')
			vpnConf += "remote #{body.vpnhost} #{body.vpnport}\n"

			console.log('Configuring VPN')
			fs.writeFileSync('/etc/openvpn/ca.crt', body.ca)
			fs.writeFileSync('/etc/openvpn/client.crt', body.cert)
			fs.writeFileSync('/etc/openvpn/client.key', body.key)
			fs.writeFileSync('/etc/openvpn/client.conf', vpnConf)

			callback(null)
		)
	(callback) ->
		console.log('Starting VPN client..')
		exec('systemctl start openvpn@client', callback)
	(callback) ->
		console.log('Enabling VPN client..')
		exec('systemctl enable openvpn@client', callback)
]

module.exports = (callback) ->
	async.waterfall(bootstrapTasks, callback)
