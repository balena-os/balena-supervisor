Promise = require 'bluebird'
_ = require 'lodash'
TypedError = require 'typed-error'
lockFile = Promise.promisifyAll(require('lockfile'))
Lock = require 'rwlock'

constants = require './constants'

ENOENT = (err) -> err.code is 'ENOENT'

exports.lockPath = (appId) ->
	return "/tmp/resin-supervisor/#{appId}"

lockFileOnHost = (appId) ->
	return "#{constants.rootMountPoint}#{exports.lockPath(appId)}/resin-updates.lock"

exports.UpdatesLockedError = class UpdatesLockedError extends TypedError

exports.lock = do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	return (appId, { force = false } = {}) ->
		Promise.try ->
			return if !appId?
			tmpLockName = lockFileOnHost(appId)
			_writeLock(tmpLockName)
			.tap (release) ->
				lockFile.unlockAsync(tmpLockName) if force == true
				lockFile.lockAsync(tmpLockName)
				.catch ENOENT, _.noop
				.catch (err) ->
					release()
					throw new exports.UpdatesLockedError("Updates are locked: #{err.message}")
			.disposer (release) ->
				Promise.try ->
					lockFile.unlockAsync(tmpLockName)
				.finally ->
					release()