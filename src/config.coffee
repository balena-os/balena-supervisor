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
	successMessage: 'SUPERVISOR OK'

config.remoteImage = config.registryEndpoint + '/' + config.localImage

config.supervisorContainer =
		Volumes:
			'/boot/config.json': {}
			'/data': {}
			'/run/docker.sock': {}
			'/mnt/fib_trie': {}
		Binds: [
			config.configMountPoint + ':/boot/config.json'
			'/var/run/docker.sock:/run/docker.sock'
			'/resin-data/resin-supervisor:/data'
			'/proc/net/fib_trie:/mnt/fib_trie'
		]
