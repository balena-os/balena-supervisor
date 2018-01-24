// Deploy a supervisor image as a supervisor_release in the Resin API
//
// Environment variables:
// This program deploys for all device types, or only device types where the architecture matches $ARCH, if specified.
// It deploys to the API specified by $API_ENDPOINT and using a provided $API_TOKEN or $API_KEY
// (if both are set, API_TOKEN is preferred).
// The tag to deploy must be passed as $TAG.
//
const PineJsClient = require('pinejs-client');
const Promise = require('bluebird');
const _ = require('lodash');
const url = require('url');

const apiEndpoint = process.env.API_ENDPOINT;
const apikey = process.env.API_KEY;
const arch = process.env.ARCH;
const tag = process.env.TAG;
const apiToken = process.env.API_TOKEN;

if (_.isEmpty(apikey) && _.isEmpty(apiToken)) {
	console.error('Skipping deploy due to empty API_KEY and API_TOKEN');
	process.exit(0);
}

if (_.isEmpty(apiEndpoint)) {
	console.error('Please set a valid $API_ENDPOINT');
	process.exit(1);
}

if (_.isEmpty(tag)) {
	console.error('Please set a $TAG to deploy');
	process.exit(1);
}

const supportedArchitectures = [ 'amd64', 'rpi', 'aarch64', 'armel', 'i386', 'armv7hf', 'i386-nlp' ];
if (!_.isEmpty(arch) && !_.includes(supportedArchitectures, arch)) {
	console.error('Invalid architecture ' + arch);
	process.exit(1);
}
const archs = _.isEmpty(arch) ? supportedArchitectures : [ arch ];
const quarkSlugs = [ 'iot2000', 'cybertan-ze250' ];

const requestOpts = {
	gzip: true,
	timeout: 30000
};

if (!_.isEmpty(apiToken)) {
	requestOpts.headers = {
		Authorization: 'Bearer ' + apiToken
	};
}


const apiEndpointWithPrefix = url.resolve(apiEndpoint, '/v2/')
const resinApi = new PineJsClient({
	apiPrefix: apiEndpointWithPrefix,
	passthrough: requestOpts
});

resinApi._request(_.extend({
	url: apiEndpoint + '/config/device-types',
	method: 'GET'
}, resinApi.passthrough))
.then( (deviceTypes) => {
	// This is a critical step so we better do it serially
	return Promise.mapSeries(deviceTypes, (deviceType) => {
		if (archs.indexOf(deviceType.arch) >= 0) {
			const customOptions = {};
			let arch = deviceType.arch;
			if (_.isEmpty(apiToken)) {
				customOptions.apikey = apikey;
			}
			if (quarkSlugs.indexOf(deviceType.slug) >= 0) {
				arch = 'i386-nlp';
			}
			console.log(`Deploying ${tag} for ${deviceType.slug}`);
			return resinApi.post({
				resource: 'supervisor_release',
				body: {
					image_name: `resin/${arch}-supervisor`,
					supervisor_version: tag,
					device_type: deviceType.slug,
					is_public: true
				},
				customOptions
			});
		}
	});
})
.then( () => {
	process.exit(0);
})
.catch( (err) => {
	console.error(`Error when deploying the supervisor to ${apiEndpoint}`, err, err.stack);
	process.exit(1);
});
