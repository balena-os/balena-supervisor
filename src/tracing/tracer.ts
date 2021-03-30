import * as opentelemetry from '@opentelemetry/api';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import {
	BasicTracerProvider,
	BatchSpanProcessor,
} from '@opentelemetry/tracing';

import * as deviceConfig from '../device-config';
import { checkTruthy } from '../lib/validation';

// Add your zipkin url (`http://localhost:9411/api/v2/spans` is used as
// default) and application name to the Zipkin options.
// You can also define your custom headers which will be added automatically.
const options = {
	url: 'http://localhost:9411/api/v2/spans',
	serviceName: 'supervisor-state-funnel',
};
const exporter = new ZipkinExporter(options);

const provider = new BasicTracerProvider();

opentelemetry.trace.setGlobalTracerProvider(provider);

// Configure span processor to send spans to the exporter
provider.addSpanProcessor(new BatchSpanProcessor(exporter));

provider.register();

export const tracer = opentelemetry.trace.getTracer('state-engine-funnel');

let enabled = false;

export async function initialize() {
	const conf = await deviceConfig.getCurrent();
	enabled = checkTruthy(conf.HOST_DEBUG);
}

export function startSpan(
	name: string,
	attributes?: opentelemetry.SpanAttributes | undefined,
	parent?: opentelemetry.Span | undefined,
): opentelemetry.Span | null {
	if (enabled || parent) {
		if (parent) {
			return tracer.startSpan(name, { attributes }, createContext(parent));
		}
		return tracer.startSpan(name, { attributes });
	} else {
		return null;
	}
}

export function createContext(parentSpan: opentelemetry.Span) {
	return opentelemetry.setSpan(opentelemetry.context.active(), parentSpan);
}
