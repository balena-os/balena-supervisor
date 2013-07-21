settings = require('./settings')
state = require('./state')
{exec} = require('child_process')

bootstrapTasks = [
	# get config from extra partition
	(callback) ->
		try
			callback(null, require('/mnt/config.json'))
		catch error
			callback(error)
	# bootstrapping
	(config, callback) ->
		request.post("#{settings.API_ENDPOINT}/associate", {
			json:
				user: config.id
		}, (error, response, body) ->
			if error or response.statusCode is 404
				return callback('Error associating with user')

			state.virgin = false
			state.uuid = body.uuid
			state.gitUrl = body.gitUrl
			state.sync()

			vpnConf = fs.readFileSync('/etc/openvpn/client.conf.template', 'utf8')
			vpnConf += "remote #{body.vpnhost} #{body.vpnport}")

			fs.writeFileSync('/etc/openvpn/ca.crt', body.ca)
			fs.writeFileSync('/etc/openvpn/client.crt', body.cert)
			fs.writeFileSync('/etc/openvpn/client.key', body.key)
			fs.writeFileSync('/etc/openvpn/client.conf', vpnConf)

			callback(null)
		)
	(callback) -> exec('systemctl start openvpn@client', callback)
	(callback) -> exec('systemctl enable openvpn@client', callback)
]

module.exports = (callback) ->
