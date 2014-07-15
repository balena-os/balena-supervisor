module.exports = config =
	apiEndpoint: process.env.API_ENDPOINT ? 'https://api.resin.io'
	registryEndpoint: process.env.REGISTRY_ENDPOINT ? 'registry.resin.io'
	pubnub:
		subscribe_key: process.env.PUBNUB_SUBSCRIBE_KEY ? 'sub-c-bananas'
		publish_key: process.env.PUBNUB_PUBLISH_KEY ? 'pub-c-bananas'
	mixpanelToken: process.env.MIXPANEL_TOKEN ? 'bananasbananas'
	dockerSocket: process.env.DOCKER_SOCKET ? '/run/docker.sock'
