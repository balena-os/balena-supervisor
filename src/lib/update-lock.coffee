Promise = require 'bluebird'
_ = require 'lodash'
TypedError = require 'typed-error'
lockFile = Promise.promisifyAll(require('lockfile'))
Lock = require 'rwlock'
fs = Promise.promisifyAll(require('fs'))

constants = require './constants'

ENOENT = (err) -> err.code is 'ENOENT'

baseLockPath = (appId) ->
	return "/tmp/resin-supervisor/services/#{appId}"
exports.lockPath = (appId, serviceName) ->
	return "#{baseLockPath(appId)}/#{serviceName}"

lockFileOnHost = (appId, serviceName) ->
	return "#{constants.rootMountPoint}#{exports.lockPath(appId, serviceName)}/resin-updates.lock"

exports.UpdatesLockedError = class UpdatesLockedError extends TypedError

exports.lock = do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	return (appId, { force = false } = {}) ->
		Promise.try ->
			return if !appId?
			locksTaken = []
			dispose = (release) ->
				Promise.map locksTaken, (lockName) ->
					lockFile.unlockAsync(lockName)
				.finally ->
					release()
			_writeLock(appId)
			.tap (release) ->
				fs.readdirAsync(baseLockPath(appId))
				.catch ENOENT, -> []
				.mapSeries (serviceName) ->
					tmpLockName = lockFileOnHost(appId, serviceName)
					Promise.try ->
						lockFile.unlockAsync(tmpLockName) if force == true
					.then ->
						lockFile.lockAsync(tmpLockName)
						.then ->
							locksTaken.push(tmpLockName)
					.catch ENOENT, _.noop
					.catch (err) ->
						dispose(release)
						.finally ->
							throw new exports.UpdatesLockedError("Updates are locked: #{err.message}")
			.disposer(dispose)
