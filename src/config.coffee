checkInt = (s) ->
	# Make sure `s` exists and is not an empty string.
	if !s
		return
	i = parseInt(s, 10)
	if isNaN(i)
		return
	return i

checkValidKey = (s) ->
	# Make sure `s` exists and is not an empty string, or 'null'.
	if !s? or s == 'null' or s == ''
		return
	return s

module.exports = config =
	apiEndpoint: process.env.API_ENDPOINT ? 'https://api.resin.io'
	listenPort: process.env.LISTEN_PORT ? 80
	gosuperAddress: "http://unix:#{process.env.GOSUPER_SOCKET}:"
	deltaEndpoint: process.env.DELTA_ENDPOINT ? 'https://delta.staging.resin.io'
	registryEndpoint: process.env.REGISTRY_ENDPOINT ? 'registry.resin.io'
	pubnub:
		subscribe_key: checkValidKey(process.env.PUBNUB_SUBSCRIBE_KEY) ? process.env.DEFAULT_PUBNUB_SUBSCRIBE_KEY
		publish_key: checkValidKey(process.env.PUBNUB_PUBLISH_KEY) ? process.env.DEFAULT_PUBNUB_PUBLISH_KEY
	mixpanelToken: checkValidKey(process.env.MIXPANEL_TOKEN) ? process.env.DEFAULT_MIXPANEL_TOKEN
	dockerSocket: process.env.DOCKER_SOCKET ? '/run/docker.sock'
	supervisorImage: process.env.SUPERVISOR_IMAGE ? 'resin/rpi-supervisor'
	configMountPoint: process.env.CONFIG_MOUNT_POINT ? '/mnt/mmcblk0p1/config.json'
	ledFile: process.env.LED_FILE ? '/sys/class/leds/led0/brightness'
	bootstrapRetryDelay: checkInt(process.env.BOOTSTRAP_RETRY_DELAY_MS) ? 30000
	restartSuccessTimeout: checkInt(process.env.RESTART_SUCCESS_TIMEOUT) ? 60000
	appUpdatePollInterval: checkInt(process.env.APPLICATION_UPDATE_POLL_INTERVAL) ? 60000
	successMessage: 'SUPERVISOR OK'
	forceSecret:
		api: process.env.RESIN_SUPERVISOR_SECRET ? null
		logsChannel: process.env.RESIN_SUPERVISOR_LOGS_CHANNEL ? null
	vpnStatusPath: process.env.VPN_STATUS_PATH ? '/mnt/root/run/openvpn/vpn_status'
	checkInt: checkInt
