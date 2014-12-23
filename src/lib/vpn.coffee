Promise = require 'bluebird'
csrgen = Promise.promisify require 'csr-gen'
fs = Promise.promisifyAll require 'fs'
request = Promise.promisifyAll require 'request'
url = require 'url'

exports.generate = (apiEndpoint, userConfig) ->
	# Generate SSL certificate
	keys = csrgen(userConfig.uuid,
		company: 'Rulemotion Ltd'
		csrName: 'client.csr'
		keyName: 'client.key'
		outputDir: '/data'
		email: 'vpn@resin.io'
		read: true
		country: ''
		city: ''
		state: ''
		division: ''
	)
	.then (keys) ->
		console.log('UUID:', userConfig.uuid)
		console.log('User ID:', userConfig.userId)
		console.log('User:', userConfig.username)
		console.log('API key:', userConfig.apiKey)
		console.log('Application ID:', userConfig.applicationId)
		console.log('CSR :', keys.csr)
		console.log('Posting to the API..')
		userConfig.csr = keys.csr
		return request.postAsync(
			url: url.resolve(apiEndpoint, 'sign_certificate?apikey=' + userConfig.apiKey)
			gzip: true
			json: userConfig
		)
	.spread (response, body) ->
		if response.statusCode >= 400
			throw body

		console.log('Configuring VPN..', JSON.stringify(body))

		for prop in ['ca', 'cert', 'vpnhost', 'vpnport'] when _.isEmpty(body[prop])
			throw new Error("'#{prop}' is empty, cannot bootstrap")

		vpnConf = fs.readFileAsync(__dirname + '/openvpn.conf.tmpl', 'utf8')
			.then (tmpl) ->
				fs.writeFileAsync('/data/client.conf', _.template(tmpl)(body))

		Promise.all([
			fs.writeFileAsync('/data/ca.crt', body.ca)
			fs.writeFileAsync('/data/client.crt', body.cert)
			vpnConf
		])