{spawn} = require('child_process')
{getpwnam} = require('posix')
async = require('async')
{EventEmitter} = require('events')
_ = require('lodash')
state = require('./state')

class Application extends EventEmitter
	constructor: (@repo, @path, @user) ->
		EventEmitter.call(this)
		@process = null
		@inprogress = false
		@queue = []
		@options =
			cwd: @path
			stdio: 'inherit'
			uid: getpwnam(@user).uid
			env:
				USER: @user
				USERNAME: @user

	_init: (callback) ->
		tasks = [
			# Create the directory for the project
			(callback) =>
				spawn('mkdir', ['-p', @path]).on('exit', callback).on('error', callback)

			# Change the owner to the user
			(callback) =>
				spawn('chown', [@user, @path]).on('exit', callback).on('error', callback)

			# Initalize a new empty git repo
			(callback) =>
				spawn('git', ['init'], @options).on('exit', callback).on('error', callback)

			# Add the remote origin to the repo
			(callback) =>
				spawn('git', ['remote', 'add', 'origin', @repo], @options).on('exit', callback).on('error', callback)
		]
		@emit('pre-init')
		async.series(tasks, =>
			@emit('post-init')
			callback?(arguments...)
		)

	_start: (callback) ->
		if not @process
			@process = spawn('foreman', ['start'], @options)
		@emit('start')
		callback?()

	_stop: (callback) ->
		# Kill will return false if process has already died
		handler = =>
			@process = null
			@emit('stop')
			callback?(arguments...)
			
		spawn('pkill', ['-TERM', '-P', @process.pid], @options).on('exit', handler).on('error', handler)

	_update: (callback) ->
		shouldRestartApp = Boolean(@process)
		tasks = [
			# Stop the application if running
			(callback) =>
				if shouldRestartApp
					@_stop(callback)
				else
					callback()
			
			# Pull new commits
			(callback) =>
				spawn('git', ['pull', 'origin', 'master'], @options).on('exit', callback).on('error', callback)

			# Save the new commit hash
			(callback) =>
				options = _.clone(@options)
				delete options.stdio
				ps = spawn('git', ['rev-parse', 'HEAD'], options).on('close', callback).on('error', callback)

				# The hash will always be on the first chunk as I/O buffers are always larger than 40 bytes
				ps.stdout.on('data', (hash) ->
					hash = '' + hash
					state.set('gitHash', hash.trim())
				)

			# Install npm dependencies
			(callback) =>
				spawn('npm', ['install'], @options).on('exit', callback).on('error', callback)

			# Start the app
			(callback) =>
				if shouldRestartApp
					@_start(callback)
				else
					callback()
		]
		@emit('pre-update')
		async.series(tasks, =>
			@emit('post-update')
			callback?(arguments...)
		)
	
	# These methods shouldn't be called in parallel, queue them if they conflict
	['start', 'stop', 'init', 'update'].forEach((method) ->
		Application::[method] = (callback) ->
			if @inprogress
				@queue.push([method, arguments])
			else
				@inprogress = true
				@['_' + method](=>
					@inprogress = false
					if @queue.length isnt 0
						[next, args] = @queue.shift()
						@[next](args...)
					callback?(arguments...)
				)
	)

module.exports = Application
