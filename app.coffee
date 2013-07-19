fs = require('fs')
async = require('async')
request = require('request')
posix = require('posix')
{exec, spawn} = require('child_process')

STATE_FILE = '/opt/ewa-client-bootstrap/state.json'
API_ENDPOINT = 'http://paras.rulemotion.com:1337'
HAKI_PATH = '/home/haki'
POLLING_INTERVAL = 30000

try
	state = require(STATE_FILE)
catch e
	console.error(e)
	process.exit()

bootstrapTasks = [
	# get config from extra partition
	(callback) ->
		try
			callback(null, require('/mnt/config.json'))
		catch error
			callback(error)
	# bootstrapping
	(config, callback) ->
		request.post("#{API_ENDPOINT}/associate", {
			json:
				user: config.id
		}, (error, response, body) ->
			if error
				return callback(error)

			if typeof body isnt 'object'
				callback(body)

			state.virgin = false
			state.uuid = body.uuid
			state.gitUrl = body.gitUrl

			fs.writeFileSync('/etc/openvpn/ca.crt', body.ca)
			fs.writeFileSync('/etc/openvpn/client.crt', body.cert)
			fs.writeFileSync('/etc/openvpn/client.key', body.key)
			fs.appendFileSync('/etc/openvpn/client.conf', "remote #{body.vpnhost} #{body.vpnport}")

			callback(null)
		)
]

hakiExec = (command, options, callback) ->
	options.uid = posix.getpwnam('haki').uid

	ps = spawn(process.env.SHELL, ['-c', command], options)
	stdout = ''
	stderr = ''
	ps.stdout.on('data', (chunk) ->
		stdout += chunk
	)
	ps.stderr.on('data', (chunk) ->
		stderr += chunk
	)
	ps.on('exit', (error) -> callback(error, stdout, stderr))
	ps.on('error', (error) -> callback(error, stdout, stderr))

stage1Tasks = [
	# superuser tasks
	(callback) -> async.waterfall(bootstrapTasks, callback)
	(callback) -> fs.writeFileSync(STATE_FILE, JSON.stringify(state)) ; callback()
	(callback) -> exec('systemctl start openvpn@client', callback)
	(callback) -> exec('systemctl enable openvpn@client', callback)
	# haki user tasks
	(callback) -> hakiExec('mkdir hakiapp', cwd: HAKI_PATH, callback)
	(callback) -> hakiExec('git init', cwd: "#{HAKI_PATH}/hakiapp", callback)
	(callback) -> hakiExec("git remote add origin #{state.gitUrl}", cwd: "#{HAKI_PATH}/hakiapp", callback)
	# done
	(callback) -> console.log('Bootstrapped') ; callback()
]

updateRepo = (callback) ->
	tasks1 = [
		(callback) -> hakiExec('git pull origin master', cwd: "#{HAKI_PATH}/hakiapp", callback)
		(stdout, stderr, callback) -> hakiExec('git rev-parse HEAD', cwd: "#{HAKI_PATH}/hakiapp", callback)
		(stdout, stderr, callback) -> callback(null, stdout.trim())
	]

	tasks2 = [
		(callback) ->
			console.log("Checking for package.json")
			if fs.existsSync("#{HAKI_PATH}/hakiapp/package.json")
				console.log("Found, npm installing")
				ps = spawn('sudo', ['-u', 'haki', 'npm', 'install'],
					cwd: "#{HAKI_PATH}/hakiapp"
					stdio: [0, 1, 2]
				)
				ps.on('exit', callback)
				ps.on('error', callback)
			else
				console.log("No package.json")
				callback()
		(callback) ->
			console.log("Checking for Procfile")
			if fs.existsSync("#{HAKI_PATH}/hakiapp/Procfile")
				console.log("Found Procfile, starting app..")
				ps = spawn('foreman', ['start'],
					cwd: "#{HAKI_PATH}/hakiapp"
					stdio: [0, 1, 2]
					uid: posix.getpwnam('haki').uid
				)
				ps.on('exit', callback)
				ps.on('error', callback)
			else
				console.log("No Procfile found")
				callback()
	]

	async.waterfall(tasks1, (error, hash) ->
		console.log("Checking for new version..")
		if hash isnt state.gitHead
			console.log("New version found #{state.gitHead}->#{hash}")
			state.gitHead = hash
			fs.writeFileSync(STATE_FILE, JSON.stringify(state))
			async.series(tasks2, (callback) -> setTimeout(callback, POLLING_INTERVAL))
		else
			console.log("No new version found")
			setTimeout(callback, POLLING_INTERVAL)
	)

stage2Tasks = [
	(callback) -> async.forever(updateRepo, callback)
]

if state.virgin
	tasks = stage1Tasks.concat(stage2Tasks)
else
	tasks = stage2Tasks

async.series(tasks, (error, results) ->
	if (error)
		console.error(error)
)
