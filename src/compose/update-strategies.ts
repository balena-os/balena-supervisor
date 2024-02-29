import * as imageManager from './images';
import type Service from './service';
import type { CompositionStep } from './composition-steps';
import { generateStep } from './composition-steps';
import { InternalInconsistencyError } from '../lib/errors';
import { checkString } from '../lib/validation';

export interface StrategyContext {
	current: Service;
	target?: Service;
	needsDownload: boolean;
	dependenciesMetForStart: boolean;
	dependenciesMetForKill: boolean;
	needsSpecialKill: boolean;
}

export function getStepsFromStrategy(
	strategy: string,
	context: StrategyContext,
): CompositionStep {
	switch (strategy) {
		case 'download-then-kill':
			if (context.needsDownload && context.target) {
				return generateStep('fetch', {
					image: imageManager.imageFromService(context.target),
					serviceName: context.target.serviceName,
				});
			} else if (context.dependenciesMetForKill) {
				// We only kill when dependencies are already met, so that we minimize downtime
				return generateStep('kill', { current: context.current });
			} else {
				return generateStep('noop', {});
			}
		case 'kill-then-download':
		case 'delete-then-download':
			return generateStep('kill', { current: context.current });
		case 'hand-over':
			if (context.needsDownload && context.target) {
				return generateStep('fetch', {
					image: imageManager.imageFromService(context.target),
					serviceName: context.target.serviceName,
				});
			} else if (context.needsSpecialKill && context.dependenciesMetForKill) {
				return generateStep('kill', { current: context.current });
			} else if (context.dependenciesMetForStart && context.target) {
				return generateStep('handover', {
					current: context.current,
					target: context.target,
				});
			} else {
				return generateStep('noop', {});
			}
		default:
			throw new InternalInconsistencyError(
				`Invalid update strategy: ${strategy}`,
			);
	}
}

export function getStrategyFromService(svc: Service): string {
	let strategy =
		checkString(svc.config.labels['io.balena.update.strategy']) || '';

	const validStrategies = [
		'download-then-kill',
		'kill-then-download',
		'delete-then-download',
		'hand-over',
	];

	if (!validStrategies.includes(strategy)) {
		strategy = 'download-then-kill';
	}

	return strategy;
}
