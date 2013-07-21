{spawn} = require('child_process')
{getpwnam} = require('posix')
async = require('async')

class Application
	constructor: (@repo, @path, @user) ->
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
		async.series(tasks, callback)

	_start: (callback) ->
		if not @process
			@process = spawn('foreman', ['start'], @options)
		callback?()

	_stop: (callback) ->
		# Kill will return false if process has already died
		handler = =>
			@process = null
			callback?()
			
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
		async.series(tasks, callback)
	
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
