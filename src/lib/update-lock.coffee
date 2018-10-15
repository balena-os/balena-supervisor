Promise = require 'bluebird'
_ = require 'lodash'
TypedError = require 'typed-error'
lockFile = Promise.promisifyAll(require('lockfile'))
Lock = require 'rwlock'
fs = Promise.promisifyAll(require('fs'))
path = require 'path'

constants = require './constants'

{ ENOENT } = require './errors'

baseLockPath = (appId) ->
	return path.join('/tmp/balena-supervisor/services', appId.toString())

exports.lockPath = (appId, serviceName) ->
	return path.join(baseLockPath(appId), serviceName)

lockFilesOnHost = (appId, serviceName) ->
	return _.map [ 'updates.lock', 'resin-updates.lock' ], (fileName) ->
		path.join(constants.rootMountPoint, exports.lockPath(appId, serviceName), fileName)

exports.UpdatesLockedError = class UpdatesLockedError extends TypedError
locksTaken = {}

# Try to clean up any existing locks when the program exits
process.on 'exit', ->
	for lockName of locksTaken
		try
			lockFile.unlockSync(lockName)

exports.lock = do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	return (appId, { force = false } = {}, fn) ->
		takeTheLock = ->
			Promise.try ->
				return if !appId?
				dispose = (release) ->
					Promise.map _.keys(locksTaken), (lockName) ->
						delete locksTaken[lockName]
						lockFile.unlockAsync(lockName)
					.finally(release)
				_writeLock(appId)
				.tap (release) ->
					theLockDir = path.join(constants.rootMountPoint, baseLockPath(appId))
					fs.readdirAsync(theLockDir)
					.catchReturn(ENOENT, [])
					.mapSeries (serviceName) ->
						Promise.mapSeries lockFilesOnHost(appId, serviceName), (tmpLockName) ->
							Promise.try ->
								lockFile.unlockAsync(tmpLockName) if force == true
							.then ->
								lockFile.lockAsync(tmpLockName)
							.then ->
								locksTaken[tmpLockName] = true
							.catchReturn(ENOENT, null)
						.catch (err) ->
							dispose(release)
							.throw(new exports.UpdatesLockedError("Updates are locked: #{err.message}"))
				.disposer(dispose)
		Promise.using takeTheLock(), -> fn()
