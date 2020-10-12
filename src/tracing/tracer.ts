import { initTracer } from 'jaeger-client';

// See schema https://github.com/jaegertracing/jaeger-client-node/blob/master/src/configuration.js#L37
const config = {
	serviceName: 'supervisor',
	reporter: {
		logSpans: true,
		agentHost: '127.0.0.1',
		agentPort: 6832,
	},
	sampler: {
		type: 'const',
		param: 1.0,
	},
};
const options = {};
const tracer = initTracer(config, options);

export default tracer;
