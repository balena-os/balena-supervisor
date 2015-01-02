checkInt = (s) ->
	# Make sure `s` exists and is not an empty string.
	if !s
		return
	i = parseInt(s, 10)
	if isNaN(i)
		return
	return i

module.exports = config =
	apiEndpoint: process.env.API_ENDPOINT ? 'https://api.resin.io'
	registryEndpoint: process.env.REGISTRY_ENDPOINT ? 'registry.resin.io'
	pubnub:
		subscribe_key: process.env.PUBNUB_SUBSCRIBE_KEY ? 'sub-c-bananas'
		publish_key: process.env.PUBNUB_PUBLISH_KEY ? 'pub-c-bananas'
	mixpanelToken: process.env.MIXPANEL_TOKEN ? 'bananasbananas'
	dockerSocket: process.env.DOCKER_SOCKET ? '/run/docker.sock'
	localImage: process.env.SUPERVISOR_IMAGE ? 'resin/rpi-supervisor'
	configMountPoint: process.env.CONFIG_MOUNT_POINT ? '/mnt/mmcblk0p1/config.json'
	ledFile: process.env.LED_FILE ? '/sys/class/leds/led0/brightness'
	bootstrapRetryDelay: checkInt(process.env.BOOTSTRAP_RETRY_DELAY_MS) ? 30000
	restartSuccessTimeout: checkInt(process.env.RESTART_SUCCESS_TIMEOUT) ? 60000
	appUpdatePollInterval: checkInt(process.env.APPLICATION_UPDATE_POLL_INTERVAL) ? 60000
	successMessage: 'SUPERVISOR OK'

config.heartbeatEndpoint = config.apiEndpoint + '/ping'

config.remoteImage = config.registryEndpoint + '/' + config.localImage

config.supervisorContainer =
		Volumes:
			'/boot/config.json': {}
			'/data': {}
			'/run/docker.sock': {}
			'/mnt/fib_trie': {}
			'/var/log': {}
		Binds: [
			config.configMountPoint + ':/boot/config.json'
			'/var/run/docker.sock:/run/docker.sock'
			'/resin-data/resin-supervisor:/data'
			'/proc/net/fib_trie:/mnt/fib_trie'
			'/var/log/supervisor-log:/var/log'
		]
