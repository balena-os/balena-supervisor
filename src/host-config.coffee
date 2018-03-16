Promise = require 'bluebird'
_ = require 'lodash'
systemd = require './lib/systemd'
path = require 'path'
constants = require './lib/constants'
fs = Promise.promisifyAll(require('fs'))
{ writeFileAtomic } = require './lib/fs-utils'
mkdirp = Promise.promisify(require('mkdirp'))

ENOENT = (err) -> err.code is 'ENOENT'

redsocksHeader = '''
	base {
		log_debug = off;
		log_info = on;
		log = stderr;
		daemon = off;
		redirector = iptables;
	}

	redsocks {
		local_ip = 127.0.0.1;
		local_port = 12345;

	'''

redsocksFooter = '}\n'

proxyFields = [ 'type', 'ip', 'port', 'login', 'password' ]

proxyBasePath = path.join(constants.rootMountPoint, constants.bootMountPoint, 'system-proxy')
redsocksConfPath = path.join(proxyBasePath, 'redsocks.conf')
noProxyPath = path.join(proxyBasePath, 'no_proxy')

readProxy = ->
	fs.readFileAsync(redsocksConfPath)
	.then (redsocksConf) ->
		lines = new String(redsocksConf).split('\n')
		conf = {}
		for line in lines
			for proxyField in proxyFields
				if proxyField in [ 'login', 'password' ]
					m = line.match(new RegExp(proxyField + '\\s*=\\s*\"(.*)\"\\s*;'))
				else
					m = line.match(new RegExp(proxyField + '\\s*=\\s*([^;\\s]*)\\s*;'))
				if m?
					conf[proxyField] = m[1]
		return conf
	.catch ENOENT, ->
		return null
	.then (conf) ->
		if !conf?
			return null
		else
			fs.readFileAsync(noProxyPath)
			.then (noProxy) ->
				conf.noProxy = new String(noProxy).split('\n')
				return conf
			.catch ENOENT, ->
				return conf

generateRedsocksConfEntries = (conf) ->
	val = ''
	for field in proxyFields
		if conf[field]?
			v = conf[field]
			if field in [ 'login', 'password' ]
				v = "\"#{v}\""
			val += "\t#{field} = #{v};\n"
	return val

setProxy = (conf) ->
	Promise.try ->
		if _.isEmpty(conf)
			fs.unlinkAsync(redsocksConfPath)
			.catch(ENOENT, _.noop)
			.then ->
				fs.unlinkAsync(noProxyPath)
			.catch(ENOENT, _.noop)
		else
			mkdirp(proxyBasePath)
			.then ->
				if _.isArray(conf.noProxy)
					writeFileAtomic(noProxyPath, conf.noProxy.join('\n'))
			.then ->
				redsocksConf = ''
				redsocksConf += redsocksHeader
				redsocksConf += generateRedsocksConfEntries(conf)
				redsocksConf += redsocksFooter
				writeFileAtomic(redsocksConfPath, redsocksConf)
	.then ->
		systemd.restartService('resin-proxy-config')
	.then ->
		systemd.restartService('redsocks')

hostnamePath = path.join(constants.rootMountPoint, '/etc/hostname')
readHostname = ->
	fs.readFileAsync(hostnamePath)
	.then (hostnameData) ->
		return _.trim(new String(hostnameData))

setHostname = (val, configModel) ->
	configModel.set(hostname: val)
	.then ->
		systemd.restartService('resin-hostname')


exports.get = ->
	Promise.join(
		readProxy()
		readHostname()
		(proxy, hostname) ->
			return {
				network: {
					proxy
					hostname
				}
			}
	)

exports.patch = (conf, configModel) ->
	Promise.try ->
		if !_.isUndefined(conf?.network?.proxy)
			setProxy(conf.network.proxy)
	.then ->
		if !_.isUndefined(conf?.network?.hostname)
			setHostname(conf.network.hostname, configModel)
