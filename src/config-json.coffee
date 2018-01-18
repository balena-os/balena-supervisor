Promise = require 'bluebird'
_ = require 'lodash'
configPath = '/boot/config.json'
Lock = require 'rwlock'
fs = Promise.promisifyAll(require('fs'))
{ writeAndSyncFile } = require './lib/fs-utils'

lock = new Lock()
writeLock = Promise.promisify(lock.async.writeLock)
readLock = Promise.promisify(lock.async.readLock)
withWriteLock = do ->
	_takeLock = ->
		writeLock('config')
		.disposer (release) ->
			release()
	return (func) ->
		Promise.using(_takeLock(), func)
withReadLock = do ->
	_takeLock = ->
		readLock('config')
		.disposer (release) ->
			release()
	return (func) ->
		Promise.using(_takeLock(), func)

# write-through cache of the config.json file
userConfig = null
exports.init = ->
	fs.readFileAsync(configPath)
	.then (conf) ->
		userConfig = JSON.parse(conf)

exports.get = (key) ->
	withReadLock ->
		return userConfig[key]

exports.getAll = ->
	withReadLock ->
		return _.clone(userConfig)

exports.set = (vals = {}, keysToDelete = []) ->
	withWriteLock ->
		_.merge(userConfig, vals)
		for key in keysToDelete
			delete userConfig[key]
		writeAndSyncFile(configPath, JSON.stringify(userConfig))
