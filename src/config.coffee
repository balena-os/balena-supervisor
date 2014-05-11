module.exports = config =
	apiEndpoint: process.env.API_ENDPOINT
	registryEndpoint: process.env.REGISTRY_ENDPOINT
	pubnub:
		subscribe_key: process.env.PUBNUB_SUBSCRIBE_KEY
		publish_key: process.env.PUBNUB_PUBLISH_KEY

# TODO add a check that all variables are set and notify the user if not
