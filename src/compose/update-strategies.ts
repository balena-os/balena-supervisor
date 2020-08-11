import * as imageManager from './images';
import Service from './service';

import { InternalInconsistencyError } from '../lib/errors';
import { CompositionStep, generateStep } from './composition-steps';

export interface StrategyContext {
	current: Service;
	target: Service;
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
			if (context.needsDownload) {
				return generateStep('fetch', {
					image: imageManager.imageFromService(context.target),
					serviceName: context.target.serviceName!,
				});
			} else if (context.dependenciesMetForKill) {
				// We only kill when dependencies are already met, so that we minimize downtime
				return generateStep('kill', { current: context.current });
			} else {
				return { action: 'noop' };
			}
		case 'kill-then-download':
		case 'delete-then-download':
			return generateStep('kill', { current: context.current });
		case 'hand-over':
			if (context.needsDownload) {
				return generateStep('fetch', {
					image: imageManager.imageFromService(context.target),
					serviceName: context.target.serviceName!,
				});
			} else if (context.needsSpecialKill && context.dependenciesMetForKill) {
				return generateStep('kill', { current: context.current });
			} else if (context.dependenciesMetForStart) {
				return generateStep('handover', {
					current: context.current,
					target: context.target,
				});
			} else {
				return { action: 'noop' };
			}
		default:
			throw new InternalInconsistencyError(
				`Invalid update strategy: ${strategy}`,
			);
	}
}
