checkInt = (s) ->
	# Make sure `s` exists and is not an empty string.
	if !s
		return
	i = parseInt(s, 10)
	if isNaN(i)
		return
	return i

checkString = (s) ->
	# Make sure `s` exists and is not an empty string, or 'null' or 'undefined'.
	# This might happen if the parsing of config.json on the host using jq is wrong (it is buggy in some versions).
	if !s? or s == 'null' or s == 'undefined' or s == ''
		return
	return s

dockerRoot = checkString(process.env.DOCKER_ROOT) ? '/mnt/root/var/lib/rce'

# Defaults needed for both gosuper and node supervisor are declared in entry.sh
module.exports = config =
	apiEndpoint: checkString(process.env.API_ENDPOINT) ? 'https://api.resin.io'
	listenPort: checkInt(process.env.LISTEN_PORT) ? 80
	gosuperAddress: "http://unix:#{process.env.GOSUPER_SOCKET}:"
	deltaHost: checkString(process.env.DELTA_ENDPOINT) ? 'https://delta.resin.io'
	registryEndpoint: checkString(process.env.REGISTRY_ENDPOINT) ? 'registry.resin.io'
	pubnub:
		subscribe_key: checkString(process.env.PUBNUB_SUBSCRIBE_KEY) ? process.env.DEFAULT_PUBNUB_SUBSCRIBE_KEY
		publish_key: checkString(process.env.PUBNUB_PUBLISH_KEY) ? process.env.DEFAULT_PUBNUB_PUBLISH_KEY
	mixpanelToken: checkString(process.env.MIXPANEL_TOKEN) ? process.env.DEFAULT_MIXPANEL_TOKEN
	dockerSocket: process.env.DOCKER_SOCKET
	supervisorImage: checkString(process.env.SUPERVISOR_IMAGE) ? 'resin/rpi-supervisor'
	configMountPoint: checkString(process.env.CONFIG_MOUNT_POINT) ? '/mnt/mmcblk0p1/config.json'
	ledFile: checkString(process.env.LED_FILE) ? '/sys/class/leds/led0/brightness'
	bootstrapRetryDelay: checkInt(process.env.BOOTSTRAP_RETRY_DELAY_MS) ? 30000
	restartSuccessTimeout: checkInt(process.env.RESTART_SUCCESS_TIMEOUT) ? 60000
	appUpdatePollInterval: checkInt(process.env.APPLICATION_UPDATE_POLL_INTERVAL) ? 60000
	successMessage: 'SUPERVISOR OK'
	forceSecret:
		api: checkString(process.env.RESIN_SUPERVISOR_SECRET) ? null
		logsChannel: checkString(process.env.RESIN_SUPERVISOR_LOGS_CHANNEL) ? null
	vpnStatusPath: checkString(process.env.VPN_STATUS_PATH) ? '/mnt/root/run/openvpn/vpn_status'
	checkInt: checkInt
	hostOsVersionPath: checkString(process.env.HOST_OS_VERSION_PATH) ? '/mnt/root/etc/os-release'
	dockerRoot: dockerRoot
	btrfsRoot: checkString(process.env.BTRFS_ROOT) ? "#{dockerRoot}/btrfs/subvolumes"
