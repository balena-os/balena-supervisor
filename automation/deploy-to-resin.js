// Deploy a supervisor image as a supervisor_release in the Resin API
//
// Environment variables:
// This program deploys only for device types where the architecture matches $ARCH.
// It deploys to the API specified by $API_ENDPOINT and using a provided $API_TOKEN or $API_KEY
// (if both are set, API_TOKEN is preferred).
// The tag to deploy must be passed as $TAG.
//
var PlatformAPI = require('pinejs-client');
var Promise = require('bluebird');
var _ = require('lodash');
var url = require('url');

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

const supportedArchitectures = [ 'amd64', 'rpi', 'aarch64', 'armel', 'i386', 'armv7hf' ];
if (_.isEmpty(arch) || !_.includes(supportedArchitectures, arch)) {
	console.error('Invalid architecture ' + arch);
	process.exit(1);
}

var requestOpts = {
	gzip: true,
	timeout: 30000
}

if (!_.isEmpty(apiToken)) {
	requestOpts.headers = {
		Authorization: 'Bearer ' + apiToken
	}
}


const PLATFORM_ENDPOINT = url.resolve(apiEndpoint, '/v2/')
var resinApi = new PlatformAPI({
	apiPrefix: PLATFORM_ENDPOINT,
	passthrough: requestOpts
});

resinApi._request(_.extend({
	url: apiEndpoint + '/config',
	method: 'GET'
}, resinApi.passthrough))
.then(function (config) {
	let deviceTypes = config.deviceTypes;
	// This is a critical step so we better do it serially
	return Promise.mapSeries(deviceTypes, function (deviceType) {
		if (deviceType.arch === arch) {
			let image_name = 'registry.resinstaging.io/resin/' + arch + '-supervisor';
			let supervisor_version = tag;
			let device_type = deviceType.slug;
			let customOptions = {}
			if (_.isEmpty(apiToken)) {
				customOptions.apikey = apikey
			}
			console.log('Deploying ' + supervisor_version + ' for ' + device_type);
			return resinApi.post({
				resource: 'supervisor_release',
				body: {
					image_name: image_name,
					supervisor_version: supervisor_version,
					device_type: device_type,
					is_public: true
				},
				customOptions: customOptions
			});
		}
	});
})
.then(function(){
	process.exit(0);
})
.catch(function (err) {
	console.error('Error when deploying the supervisor to ' + apiEndpoint, err, err.stack);
	process.exit(1);
});
