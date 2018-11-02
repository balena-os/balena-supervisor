import * as _ from 'lodash';
import { inspect } from 'util';

import { EnvVarObject, LabelObject } from './types';

export interface CheckIntOptions {
	positive?: boolean;
}

const ENV_VAR_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LABEL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9\.\-]*$/;

type NullableString = string | undefined | null;
type NullableLiteral = number | NullableString;

/**
 * checkInt
 *
 * Check an input string as a number, optionally specifying a requirement
 * to be positive
 */
export function checkInt(
	s: NullableLiteral,
	options: CheckIntOptions = {},
): number | void {
	if (s == null) {
		return;
	}

	// parseInt will happily take a number, but the typings won't accept it,
	// simply cast it here
	const i = parseInt(s as string, 10);

	if (isNaN(i)) {
		return;
	}

	if (options.positive && i <= 0) {
		return;
	}

	return i;
}

/**
 * checkString
 *
 * Check that a string exists, and is not an empty string, 'null', or 'undefined'
 */
export function checkString(s: NullableLiteral): string | void {
	if (s == null || !_.isString(s) || _.includes(['null', 'undefined', ''], s)) {
		return;
	}

	return s;
}

/**
 * checkTruthy
 *
 * Given a value which can be a string, boolean or number, return a boolean
 * which represents if the input was truthy
 */
export function checkTruthy(v: string | boolean | number): boolean | void {
	switch (v) {
		case '1':
		case 'true':
		case true:
		case 'on':
		case 1:
			return true;
		case '0':
		case 'false':
		case false:
		case 'off':
		case 0:
			return false;
		default:
			return;
	}
}

/*
 * isValidShortText
 *
 * Check that the input string is definitely a string,
 * and has a length which is less than 255
 */
export function isValidShortText(t: string): boolean {
	return _.isString(t) && t.length <= 255;
}

/**
 * isValidEnv
 *
 * Given a env var object, check types and values for the keys
 * and values
 */
export function isValidEnv(obj: EnvVarObject): boolean {
	if (!_.isObject(obj)) {
		console.log('debug: Non-object passed to validation.isValidEnv');
		console.log(`\tobj: ${inspect(obj)}`);
		return false;
	}

	return _.every(obj, (val, key) => {
		if (!isValidShortText(key)) {
			console.log(
				'debug: Non-valid short text env var key passed to validation.isValidEnv',
			);
			console.log(`\tKey: ${inspect(key)}`);
			return false;
		}

		if (!ENV_VAR_KEY_REGEX.test(key)) {
			console.log('debug: Invalid env var key passed to validation.isValidEnv');
			console.log(`\tKey: ${inspect(key)}`);
			return false;
		}

		if (!_.isString(val)) {
			console.log('debug: Non-string value passed to validation.isValidEnv');
			console.log(`\tval: ${inspect(key)}`);
			return false;
		}
		return true;
	});
}

/**
 * isValidLabelsObject
 *
 * Given a labels object, test the types and values for validity
 */
export function isValidLabelsObject(obj: LabelObject): boolean {
	if (!_.isObject(obj)) {
		console.log('debug: Non-object passed to validation.isValidLabelsObject');
		console.log(`\tobj: ${inspect(obj)}`);
		return false;
	}

	return _.every(obj, (val, key) => {
		if (!isValidShortText(key)) {
			console.log(
				'debug: Non-valid short text label key passed to validation.isValidLabelsObject',
			);
			console.log(`\tkey: ${inspect(key)}`);
			return false;
		}

		if (!LABEL_NAME_REGEX.test(key)) {
			console.log(
				'debug: Invalid label name passed to validation.isValidLabelsObject',
			);
			console.log(`\tkey: ${inspect(key)}`);
			return false;
		}

		if (!_.isString(val)) {
			console.log(
				'debug: Non-string value passed to validation.isValidLabelsObject',
			);
			console.log(`\tval: ${inspect(val)}`);
			return false;
		}

		return true;
	});
}

export function isValidDeviceName(name: string): boolean {
	// currently the only disallowed value in a device name is a newline
	const newline = name.indexOf('\n') !== -1;
	if (newline) {
		console.log(
			'debug: newline found in device name. This is invalid and should be removed',
		);
	}
	return !newline;
}

function undefinedOrValidEnv(val: EnvVarObject): boolean {
	return val == null || isValidEnv(val);
}

/**
 * isValidDependentAppsObject
 *
 * Given a dependent apps object from a state endpoint, validate it
 *
 * TODO: Type the input
 */
export function isValidDependentAppsObject(apps: any): boolean {
	if (!_.isObject(apps)) {
		console.log(
			'debug: non-object passed to validation.isValidDependentAppsObject',
		);
		console.log(`\tapps: ${inspect(apps)}`);
		return false;
	}

	return _.every(apps, (val, appId) => {
		val = _.defaults(_.clone(val), {
			config: undefined,
			environment: undefined,
			commit: undefined,
			image: undefined,
		});

		if (!isValidShortText(appId) || !checkInt(appId)) {
			console.log(
				'debug: Invalid appId passed to validation.isValidDependentAppsObject',
			);
			console.log(`\tappId: ${inspect(appId)}`);
			return false;
		}

		return _.conformsTo(val, {
			name: (n: any) => {
				if (!isValidShortText(n)) {
					console.log(
						'debug: Invalid name passed to validation.isValidDependentAppsObject',
					);
					console.log(`\tname: ${inspect(n)}`);
					return false;
				}
				return true;
			},
			image: (i: any) => {
				if (val.commit != null && !isValidShortText(i)) {
					console.log(
						'debug: non valid image passed to validation.isValidDependentAppsObject',
					);
					console.log(`\timage: ${inspect(i)}`);
					return false;
				}
				return true;
			},
			commit: (c: any) => {
				if (c != null && !isValidShortText(c)) {
					console.log(
						'debug: invalid commit passed to validation.isValidDependentAppsObject',
					);
					console.log(`\tcommit: ${inspect(c)}`);
					return false;
				}
				return true;
			},
			config: (c: any) => {
				if (!undefinedOrValidEnv(c)) {
					console.log(
						'debug; Invalid config passed to validation.isValidDependentAppsObject',
					);
					console.log(`\tconfig: ${inspect(c)}`);
					return false;
				}
				return true;
			},
			environment: (e: any) => {
				if (!undefinedOrValidEnv(e)) {
					console.log(
						'debug; Invalid environment passed to validation.isValidDependentAppsObject',
					);
					console.log(`\tenvironment: ${inspect(e)}`);
					return false;
				}
				return true;
			},
		});
	});
}

function isValidService(service: any, serviceId: string): boolean {
	if (!isValidShortText(serviceId) || !checkInt(serviceId)) {
		console.log(
			'debug: Invalid service id passed to validation.isValidService',
		);
		console.log(`\tserviceId: ${inspect(serviceId)}`);
		return false;
	}

	return _.conformsTo(service, {
		serviceName: (n: any) => {
			if (!isValidShortText(n)) {
				console.log(
					'debug: Invalid service name passed to validation.isValidService',
				);
				console.log(`\tserviceName: ${inspect(n)}`);
				return false;
			}
			return true;
		},
		image: (i: any) => {
			if (!isValidShortText(i)) {
				console.log('debug: Invalid image passed to validation.isValidService');
				console.log(`\timage: ${inspect(i)}`);
				return false;
			}
			return true;
		},
		environment: (e: any) => {
			if (!isValidEnv(e)) {
				console.log('debug: Invalid env passed to validation.isValidService');
				console.log(`\tenvironment: ${inspect(e)}`);
				return false;
			}
			return true;
		},
		imageId: (i: any) => {
			if (checkInt(i) == null) {
				console.log(
					'debug: Invalid image id passed to validation.isValidService',
				);
				console.log(`\timageId: ${inspect(i)}`);
				return false;
			}
			return true;
		},
		labels: (l: any) => {
			if (!isValidLabelsObject(l)) {
				console.log(
					'debug: Invalid labels object passed to validation.isValidService',
				);
				console.log(`\tlabels: ${inspect(l)}`);
				return false;
			}
			return true;
		},
	});
}

/**
 * isValidAppsObject
 *
 * Given an apps object from the state endpoint, validate the fields and
 * return whether it's valid.
 *
 * TODO: Type the input correctly
 */
export function isValidAppsObject(obj: any): boolean {
	if (!_.isObject(obj)) {
		console.log('debug: Invalid object passed to validation.isValidAppsObject');
		console.log(`\tobj: ${inspect(obj)}`);
		return false;
	}

	return _.every(obj, (val, appId) => {
		if (!isValidShortText(appId) || !checkInt(appId)) {
			console.log(
				'debug: Invalid appId passed to validation.isValidAppsObject',
			);
			console.log(`\tappId: ${inspect(appId)}`);
			return false;
		}

		return _.conformsTo(_.defaults(_.clone(val), { releaseId: undefined }), {
			name: (n: any) => {
				if (!isValidShortText(n)) {
					console.log(
						'debug: Invalid service name passed to validation.isValidAppsObject',
					);
					console.log(`\tname: ${inspect(n)}`);
					return false;
				}
				return true;
			},
			releaseId: (r: any) => {
				if (r != null && checkInt(r) == null) {
					console.log(
						'debug: Invalid releaseId passed to validation.isValidAppsObject',
					);
					console.log(`\treleaseId: ${inspect(r)}`);
					return false;
				}
				return true;
			},
			services: (s: any) => {
				if (!_.isObject(s)) {
					console.log(
						'debug: Non-object service passed to validation.isValidAppsObject',
					);
					console.log(`\tservices: ${inspect(s)}`);
					return false;
				}

				return _.every(s, (svc, svcId) => {
					if (!isValidService(svc, svcId)) {
						console.log(
							'debug: Invalid service object passed to validation.isValidAppsObject',
						);
						console.log(`\tsvc: ${inspect(svc)}`);
						return false;
					}
					return true;
				});
			},
		});
	});
}

/**
 * isValidDependentDevicesObject
 *
 * Validate a dependent devices object from the state endpoint.
 */
export function isValidDependentDevicesObject(devices: any): boolean {
	if (!_.isObject(devices)) {
		console.log(
			'debug: Non-object passed to validation.isValidDependentDevicesObject',
		);
		console.log(`\tdevices: ${inspect(devices)}`);
		return false;
	}

	return _.every(devices, (val, uuid) => {
		if (!isValidShortText(uuid)) {
			console.log(
				'debug: Invalid uuid passed to validation.isValidDependentDevicesObject',
			);
			console.log(`\tuuid: ${inspect(uuid)}`);
			return false;
		}

		return _.conformsTo(val, {
			name: (n: any) => {
				if (!isValidShortText(n)) {
					console.log(
						'debug: Invalid device name passed to validation.isValidDependentDevicesObject',
					);
					console.log(`\tname: ${inspect(n)}`);
					return false;
				}
				return true;
			},
			apps: (a: any) => {
				if (!_.isObject(a)) {
					console.log(
						'debug: Invalid apps object passed to validation.isValidDependentDevicesObject',
					);
					console.log(`\tapps: ${inspect(a)}`);
					return false;
				}

				if (_.isEmpty(a)) {
					console.log(
						'debug: Empty object passed to validation.isValidDependentDevicesObject',
					);
					return false;
				}

				return _.every(a, app => {
					app = _.defaults(_.clone(app), {
						config: undefined,
						environment: undefined,
					});
					return _.conformsTo(app, {
						config: (c: any) => {
							if (!undefinedOrValidEnv(c)) {
								console.log(
									'debug: Invalid config passed to validation.isValidDependentDevicesObject',
								);
								console.log(`\tconfig: ${inspect(c)}`);
								return false;
							}
							return true;
						},
						environment: (e: any) => {
							if (!undefinedOrValidEnv(e)) {
								console.log(
									'debug: Invalid environment passed to validation.isValidDependentDevicesObject',
								);
								console.log(`\tconfig: ${inspect(e)}`);
								return false;
							}
							return true;
						},
					});
				});
			},
		});
	});
}

/**
 * validStringOrUndefined
 *
 * Ensure a string is either undefined, or a non-empty string
 */
export function validStringOrUndefined(s: string | undefined): boolean {
	return _.isUndefined(s) || (_.isString(s) && !_.isEmpty(s));
}

/**
 * validStringOrUndefined
 *
 * Ensure an object is either undefined or an actual object
 */
export function validObjectOrUndefined(o: object | undefined): boolean {
	return _.isUndefined(o) || _.isObject(o);
}
