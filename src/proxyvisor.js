import * as Promise from 'bluebird';
import * as _ from 'lodash';
import * as express from 'express';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as url from 'url';

import * as request from './lib/request';
import * as constants from './lib/constants';
import {
	checkInt,
	validStringOrUndefined,
	validObjectOrUndefined,
} from './lib/validation';
import { log } from './lib/supervisor-console';
import * as dockerUtils from './lib/docker-utils';
import { InternalInconsistencyError } from './lib/errors';
import * as apiHelper from './lib/api-helper';
import { exec, mkdirp } from './lib/fs-utils';

import { normalise } from './compose/images';
import * as db from './db';
import * as config from './config';
import * as logger from './logger';
import * as apiBinder from './api-binder';
import * as dbFormat from './device-state/db-format';
import * as deviceConfig from './device-config';

const isDefined = _.negate(_.isUndefined);

const parseDeviceFields = function (device) {
	device.id = parseInt(device.deviceId, 10);
	device.appId = parseInt(device.appId, 10);
	device.config = JSON.parse(device.config ?? '{}');
	device.environment = JSON.parse(device.environment ?? '{}');
	device.targetConfig = JSON.parse(device.targetConfig ?? '{}');
	device.targetEnvironment = JSON.parse(device.targetEnvironment ?? '{}');
	return _.omit(device, 'markedForDeletion', 'logs_channel');
};

const tarDirectory = (appId) => `/data/dependent-assets/${appId}`;

const tarFilename = (appId, commit) => `${appId}-${commit}.tar`;

const tarPath = (appId, commit) =>
	`${tarDirectory(appId)}/${tarFilename(appId, commit)}`;

const getTarArchive = (source, destination) =>
	fs
		.lstat(destination)
		.catch(() =>
			mkdirp(path.dirname(destination)).then(() =>
				exec(`tar -cvf '${destination}' *`, { cwd: source }),
			),
		);

const cleanupTars = function (appId, commit) {
	let fileToKeep;
	if (commit != null) {
		fileToKeep = tarFilename(appId, commit);
	} else {
		fileToKeep = null;
	}
	const dir = tarDirectory(appId);
	return fs
		.readdir(dir)
		.catch(() => [])
		.then(function (files) {
			if (fileToKeep != null) {
				files = _.reject(files, fileToKeep);
			}
			return Promise.map(files, (file) => fs.unlink(path.join(dir, file)));
		});
};

const formatTargetAsState = (device) => ({
	appId: parseInt(device.appId, 10),
	commit: device.targetCommit,
	environment: device.targetEnvironment,
	config: device.targetConfig,
});

const formatCurrentAsState = (device) => ({
	appId: parseInt(device.appId, 10),
	commit: device.commit,
	environment: device.environment,
	config: device.config,
});

const createProxyvisorRouter = function (pv) {
	const router = express.Router();
	router.get('/v1/devices', async (_req, res) => {
		try {
			const fields = await db.models('dependentDevice').select();
			const devices = fields.map(parseDeviceFields);
			res.json(devices);
		} catch (/** @type {any} */ err) {
			res.status(503).send(err?.message || err || 'Unknown error');
		}
	});

	router.post('/v1/devices', function (req, res) {
		let { appId, device_type } = req.body;

		if (
			appId == null ||
			_.isNaN(parseInt(appId, 10)) ||
			parseInt(appId, 10) <= 0
		) {
			res.status(400).send('appId must be a positive integer');
			return;
		}
		if (device_type == null) {
			device_type = 'generic';
		}
		const d = {
			belongs_to__application: req.body.appId,
			device_type,
		};
		return apiBinder
			.provisionDependentDevice(d)
			.then(function (dev) {
				// If the response has id: null then something was wrong in the request
				// but we don't know precisely what.
				if (dev.id == null) {
					res
						.status(400)
						.send('Provisioning failed, invalid appId or credentials');
					return;
				}
				const deviceForDB = {
					uuid: dev.uuid,
					appId,
					device_type: dev.device_type,
					deviceId: dev.id,
					name: dev.name,
					status: dev.status,
				};
				return db
					.models('dependentDevice')
					.insert(deviceForDB)
					.then(() => res.status(201).send(dev));
			})
			.catch(function (err) {
				log.error(`Error on ${req.method} ${url.parse(req.url).pathname}`, err);
				return res.status(503).send(err?.message || err || 'Unknown error');
			});
	});

	router.get('/v1/devices/:uuid', function (req, res) {
		const { uuid } = req.params;
		return db
			.models('dependentDevice')
			.select()
			.where({ uuid })
			.then(function ([device]) {
				if (device == null) {
					return res.status(404).send('Device not found');
				}
				if (device.markedForDeletion) {
					return res.status(410).send('Device deleted');
				}
				return res.json(parseDeviceFields(device));
			})
			.catch(function (err) {
				log.error(`Error on ${req.method} ${url.parse(req.url).pathname}`, err);
				return res.status(503).send(err?.message || err || 'Unknown error');
			});
	});

	router.post('/v1/devices/:uuid/logs', function (req, res) {
		const { uuid } = req.params;
		const m = {
			message: req.body.message,
			timestamp: req.body.timestamp || Date.now(),
		};
		if (req.body.isSystem != null) {
			m.isSystem = req.body.isSystem;
		}

		return db
			.models('dependentDevice')
			.select()
			.where({ uuid })
			.then(function ([device]) {
				if (device == null) {
					return res.status(404).send('Device not found');
				}
				if (device.markedForDeletion) {
					return res.status(410).send('Device deleted');
				}
				logger.logDependent(m, { uuid });
				return res.status(202).send('OK');
			})
			.catch(function (err) {
				log.error(`Error on ${req.method} ${url.parse(req.url).pathname}`, err);
				return res.status(503).send(err?.message || err || 'Unknown error');
			});
	});

	router.put('/v1/devices/:uuid', function (req, res) {
		const { uuid } = req.params;
		let {
			status,
			is_online,
			commit,
			releaseId,
			environment,
			config: conf,
		} = req.body;
		const validateDeviceFields = function () {
			if (isDefined(is_online) && !_.isBoolean(is_online)) {
				return 'is_online must be a boolean';
			}
			if (!validStringOrUndefined(status)) {
				return 'status must be a non-empty string';
			}
			if (!validStringOrUndefined(commit)) {
				return 'commit must be a non-empty string';
			}
			if (!validStringOrUndefined(releaseId)) {
				return 'commit must be a non-empty string';
			}
			if (!validObjectOrUndefined(environment)) {
				return 'environment must be an object';
			}
			if (!validObjectOrUndefined(conf)) {
				return 'config must be an object';
			}
			return null;
		};
		const requestError = validateDeviceFields();
		if (requestError != null) {
			res.status(400).send(requestError);
			return;
		}

		if (isDefined(environment)) {
			environment = JSON.stringify(environment);
		}
		if (isDefined(conf)) {
			conf = JSON.stringify(conf);
		}

		const fieldsToUpdateOnDB = _.pickBy(
			{ status, is_online, commit, releaseId, config: conf, environment },
			isDefined,
		);
		/** @type {Dictionary<any>} */
		const fieldsToUpdateOnAPI = _.pick(
			fieldsToUpdateOnDB,
			'status',
			'is_online',
			'releaseId',
		);
		if (fieldsToUpdateOnDB.commit != null) {
			fieldsToUpdateOnAPI.is_on__commit = fieldsToUpdateOnDB.commit;
		}

		if (_.isEmpty(fieldsToUpdateOnDB)) {
			res.status(400).send('At least one device attribute must be updated');
			return;
		}

		return db
			.models('dependentDevice')
			.select()
			.where({ uuid })
			.then(function ([device]) {
				if (device == null) {
					return res.status(404).send('Device not found');
				}
				if (device.markedForDeletion) {
					return res.status(410).send('Device deleted');
				}
				if (device.deviceId == null) {
					throw new Error('Device is invalid');
				}
				return Promise.try(function () {
					if (!_.isEmpty(fieldsToUpdateOnAPI)) {
						return apiBinder.patchDevice(device.deviceId, fieldsToUpdateOnAPI);
					}
				})
					.then(() =>
						db
							.models('dependentDevice')
							.update(fieldsToUpdateOnDB)
							.where({ uuid }),
					)
					.then(() => db.models('dependentDevice').select().where({ uuid }))
					.then(function ([dbDevice]) {
						return res.json(parseDeviceFields(dbDevice));
					});
			})
			.catch(function (err) {
				log.error(`Error on ${req.method} ${url.parse(req.url).pathname}`, err);
				return res.status(503).send(err?.message || err || 'Unknown error');
			});
	});

	router.get('/v1/dependent-apps/:appId/assets/:commit', async (req, res) => {
		try {
			const [app] = await db
				.models('dependentApp')
				.select()
				.where(_.pick(req.params, 'appId', 'commit'));

			if (!app) {
				return res.status(404).send('Not found');
			}
			const dest = tarPath(app.appId, app.commit);
			try {
				await fs.lstat(dest);
			} catch {
				await Promise.using(
					pv.docker.imageRootDirMounted(app.image),
					(rootDir) => getTarArchive(rootDir + '/assets', dest),
				);
			}
			res.sendFile(dest);
		} catch (/** @type {any} */ err) {
			log.error(`Error on ${req.method} ${url.parse(req.url).pathname}`, err);
			return res.status(503).send(err?.message || err || 'Unknown error');
		}
	});

	router.get('/v1/dependent-apps', async (req, res) => {
		try {
			const apps = await db.models('dependentApp').select();

			const $apps = apps.map((app) => ({
				id: parseInt(app.appId, 10),
				commit: app.commit,
				name: app.name,
				config: JSON.parse(app.config ?? '{}'),
			}));
			res.json($apps);
		} catch (/** @type {any} */ err) {
			log.error(`Error on ${req.method} ${url.parse(req.url).pathname}`, err);
			return res.status(503).send(err?.message || err || 'Unknown error');
		}
	});

	return router;
};

class Proxyvisor {
	constructor() {
		this.executeStepAction = this.executeStepAction.bind(this);
		this.getCurrentStates = this.getCurrentStates.bind(this);
		this.normaliseDependentAppForDB =
			this.normaliseDependentAppForDB.bind(this);
		this.setTargetInTransaction = this.setTargetInTransaction.bind(this);
		this.getTarget = this.getTarget.bind(this);
		this._getHookStep = this._getHookStep.bind(this);
		this.nextStepsForDependentApp = this.nextStepsForDependentApp.bind(this);
		this.getRequiredSteps = this.getRequiredSteps.bind(this);
		this.getHookEndpoint = this.getHookEndpoint.bind(this);
		this.sendUpdate = this.sendUpdate.bind(this);
		this.sendDeleteHook = this.sendDeleteHook.bind(this);
		this.sendUpdates = this.sendUpdates.bind(this);
		this.acknowledgedState = {};
		this.lastRequestForDevice = {};
		this.router = createProxyvisorRouter(this);
		this.actionExecutors = {
			updateDependentTargets: (step) => {
				return config
					.initialized()
					.then(() => config.getMany(['currentApiKey', 'apiTimeout']))
					.then(({ currentApiKey, apiTimeout }) => {
						// - take each of the step.devices and update dependentDevice with it (targetCommit, targetEnvironment, targetConfig)
						// - if update returns 0, then use APIBinder to fetch the device, then store it to the db
						// - set markedForDeletion: true for devices that are not in the step.devices list
						// - update dependentApp with step.app
						return Promise.map(step.devices, (device) => {
							const { uuid } = device;
							// Only consider one app per dependent device for now
							const appId = _(device.apps).keys().head();
							if (appId == null) {
								throw new Error(
									'Could not find an app for the dependent device',
								);
							}
							const targetCommit = device.apps[appId].commit;
							const targetEnvironment = JSON.stringify(
								device.apps[appId].environment,
							);
							const targetConfig = JSON.stringify(device.apps[appId].config);
							return db
								.models('dependentDevice')
								.update({
									appId,
									targetEnvironment,
									targetConfig,
									targetCommit,
									name: device.name,
								})
								.where({ uuid })
								.then((n) => {
									if (n !== 0) {
										return;
									}
									// If the device is not in the DB it means it was provisioned externally
									// so we need to fetch it.
									if (apiBinder.balenaApi == null) {
										throw new InternalInconsistencyError(
											'proxyvisor called fetchDevice without an initialized API client',
										);
									}

									return apiHelper
										.fetchDevice(
											apiBinder.balenaApi,
											uuid,
											currentApiKey,
											apiTimeout,
										)
										.then((dev) => {
											if (dev == null) {
												throw new InternalInconsistencyError(
													`Could not fetch a device with UUID: ${uuid}`,
												);
											}
											const deviceForDB = {
												uuid,
												appId,
												device_type: dev.device_type,
												deviceId: dev.id,
												is_online: dev.is_online,
												name: dev.name,
												status: dev.status,
												targetCommit,
												targetConfig,
												targetEnvironment,
											};
											return db.models('dependentDevice').insert(deviceForDB);
										});
								});
						})
							.then(() => {
								return db
									.models('dependentDevice')
									.where({ appId: step.appId })
									.whereNotIn('uuid', _.map(step.devices, 'uuid'))
									.update({ markedForDeletion: true });
							})
							.then(() => {
								return this.normaliseDependentAppForDB(step.app);
							})
							.then((appForDB) => {
								return db.upsertModel('dependentApp', appForDB, {
									appId: step.appId,
								});
							})
							.then(() => cleanupTars(step.appId, step.app.commit));
					});
			},

			sendDependentHooks: (step) => {
				return Promise.join(
					config.get('apiTimeout'),
					this.getHookEndpoint(step.appId),
					(apiTimeout, endpoint) => {
						return Promise.mapSeries(step.devices, (device) => {
							return Promise.try(() => {
								if (this.lastRequestForDevice[device.uuid] != null) {
									const diff =
										Date.now() - this.lastRequestForDevice[device.uuid];
									if (diff < 30000) {
										return Promise.delay(30001 - diff);
									}
								}
							}).then(() => {
								this.lastRequestForDevice[device.uuid] = Date.now();
								if (device.markedForDeletion) {
									return this.sendDeleteHook(device, apiTimeout, endpoint);
								} else {
									return this.sendUpdate(device, apiTimeout, endpoint);
								}
							});
						});
					},
				);
			},

			removeDependentApp: (step) => {
				// find step.app and delete it from the DB
				// find devices with step.appId and delete them from the DB
				return db.transaction((trx) =>
					trx('dependentApp')
						.where({ appId: step.appId })
						.del()
						.then(() =>
							trx('dependentDevice').where({ appId: step.appId }).del(),
						)
						.then(() => cleanupTars(step.appId)),
				);
			},
		};
		this.validActions = _.keys(this.actionExecutors);
	}

	executeStepAction(step) {
		return Promise.try(() => {
			if (this.actionExecutors[step.action] == null) {
				throw new Error(`Invalid proxyvisor action ${step.action}`);
			}

			return this.actionExecutors[step.action](step);
		});
	}

	getCurrentStates() {
		return Promise.join(
			Promise.map(
				db.models('dependentApp').select(),
				this.normaliseDependentAppFromDB,
			),
			db.models('dependentDevice').select(),
			function (apps, devicesFromDB) {
				const devices = _.map(devicesFromDB, function (device) {
					const dev = {
						uuid: device.uuid,
						name: device.name,
						lock_expiry_date: device.lock_expiry_date,
						markedForDeletion: device.markedForDeletion,
						apps: {},
					};
					dev.apps[device.appId] = {
						commit: device.commit,
						config: JSON.parse(device.config),
						environment: JSON.parse(device.environment),
						targetCommit: device.targetCommit,
						targetEnvironment: JSON.parse(device.targetEnvironment),
						targetConfig: JSON.parse(device.targetConfig),
					};
					return dev;
				});
				return { apps, devices };
			},
		);
	}

	normaliseDependentAppForDB(app) {
		let image;
		if (app.image != null) {
			image = normalise(app.image);
		} else {
			image = null;
		}
		const dbApp = {
			appId: app.appId,
			name: app.name,
			commit: app.commit,
			releaseId: app.releaseId,
			imageId: app.imageId,
			parentApp: app.parentApp,
			image,
			config: JSON.stringify(app.config ?? {}),
			environment: JSON.stringify(app.environment ?? {}),
		};
		return Promise.props(dbApp);
	}

	normaliseDependentDeviceTargetForDB(device, appCommit) {
		return Promise.try(function () {
			const apps = _.mapValues(_.clone(device.apps ?? {}), function (app) {
				app.commit = appCommit || null;
				if (app.config == null) {
					app.config = {};
				}
				if (app.environment == null) {
					app.environment = {};
				}
				return app;
			});
			const outDevice = {
				uuid: device.uuid,
				name: device.name,
				apps: JSON.stringify(apps),
			};
			return outDevice;
		});
	}

	setTargetInTransaction(dependent, trx) {
		return Promise.try(() => {
			if (dependent?.apps != null) {
				const appsArray = _.map(dependent.apps, function (app, appId) {
					const appClone = _.clone(app);
					appClone.appId = checkInt(appId);
					return appClone;
				});
				return Promise.map(appsArray, this.normaliseDependentAppForDB)
					.tap((appsForDB) => {
						return Promise.map(appsForDB, (app) => {
							return db.upsertModel(
								'dependentAppTarget',
								app,
								{ appId: app.appId },
								trx,
							);
						});
					})
					.then((appsForDB) =>
						trx('dependentAppTarget')
							.whereNotIn('appId', _.map(appsForDB, 'appId'))
							.del(),
					);
			}
		}).then(() => {
			if (dependent?.devices != null) {
				const devicesArray = _.map(dependent.devices, function (dev, uuid) {
					const devClone = _.clone(dev);
					devClone.uuid = uuid;
					return devClone;
				});
				return Promise.map(devicesArray, (device) => {
					const appId = _.keys(device.apps)[0];
					return this.normaliseDependentDeviceTargetForDB(
						device,
						dependent.apps[appId]?.commit,
					);
				}).then((devicesForDB) => {
					return Promise.map(devicesForDB, (device) => {
						return db.upsertModel(
							'dependentDeviceTarget',
							device,
							{ uuid: device.uuid },
							trx,
						);
					}).then(() =>
						trx('dependentDeviceTarget')
							.whereNotIn('uuid', _.map(devicesForDB, 'uuid'))
							.del(),
					);
				});
			}
		});
	}

	normaliseDependentAppFromDB(app) {
		return Promise.try(function () {
			const outApp = {
				appId: app.appId,
				name: app.name,
				commit: app.commit,
				releaseId: app.releaseId,
				image: app.image,
				imageId: app.imageId,
				config: JSON.parse(app.config),
				environment: JSON.parse(app.environment),
				parentApp: app.parentApp,
			};
			return outApp;
		});
	}

	normaliseDependentDeviceTargetFromDB(device) {
		return Promise.try(function () {
			const outDevice = {
				uuid: device.uuid,
				name: device.name,
				apps: _.mapValues(JSON.parse(device.apps), function (a) {
					if (a.commit == null) {
						a.commit = null;
					}
					return a;
				}),
			};
			return outDevice;
		});
	}

	normaliseDependentDeviceFromDB(device) {
		return Promise.try(function () {
			const outDevice = _.clone(device);
			for (const prop of [
				'environment',
				'config',
				'targetEnvironment',
				'targetConfig',
			]) {
				outDevice[prop] = JSON.parse(device[prop]);
			}
			return outDevice;
		});
	}

	getTarget() {
		return Promise.props({
			apps: Promise.map(
				db.models('dependentAppTarget').select(),
				this.normaliseDependentAppFromDB,
			),
			devices: Promise.map(
				db.models('dependentDeviceTarget').select(),
				this.normaliseDependentDeviceTargetFromDB,
			),
		});
	}

	imagesInUse(current, target) {
		const images = [];
		if (current?.dependent?.apps != null) {
			_.forEach(current.dependent.apps, (app) => {
				images.push(app.image);
			});
		}
		if (target?.dependent?.apps != null) {
			_.forEach(target.dependent.apps, (app) => {
				images.push(app.image);
			});
		}
		return images;
	}

	_imageAvailable(image, available) {
		return _.some(available, { name: image });
	}

	_getHookStep(currentDevices, appId) {
		const hookStep = {
			action: 'sendDependentHooks',
			/** @type {Array<{uuid: string, target?: any, markedForDeletion?: true}>} */
			devices: [],
			appId,
		};
		for (const device of currentDevices) {
			if (device.markedForDeletion) {
				hookStep.devices.push({
					uuid: device.uuid,
					markedForDeletion: true,
				});
			} else {
				const targetState = {
					appId,
					commit: device.apps[appId].targetCommit,
					config: device.apps[appId].targetConfig,
					environment: device.apps[appId].targetEnvironment,
				};
				const currentState = {
					appId,
					commit: device.apps[appId].commit,
					config: device.apps[appId].config,
					environment: device.apps[appId].environment,
				};
				if (
					device.apps[appId].targetCommit != null &&
					!_.isEqual(targetState, currentState) &&
					!_.isEqual(targetState, this.acknowledgedState[device.uuid])
				) {
					hookStep.devices.push({
						uuid: device.uuid,
						target: targetState,
					});
				}
			}
		}
		return hookStep;
	}

	_compareDevices(currentDevices, targetDevices, appId) {
		let currentDeviceTargets = _.map(currentDevices, function (dev) {
			if (dev.markedForDeletion) {
				return null;
			}
			const devTarget = _.clone(dev);
			delete devTarget.markedForDeletion;
			delete devTarget.lock_expiry_date;
			devTarget.apps = {};
			devTarget.apps[appId] = {
				commit: dev.apps[appId].targetCommit,
				environment: dev.apps[appId].targetEnvironment || {},
				config: dev.apps[appId].targetConfig || {},
			};
			return devTarget;
		});
		currentDeviceTargets = _.filter(
			currentDeviceTargets,
			(dev) => !_.isNull(dev),
		);
		return !_.isEmpty(
			_.xorWith(currentDeviceTargets, targetDevices, _.isEqual),
		);
	}

	imageForDependentApp(app) {
		return {
			name: app.image,
			imageId: app.imageId,
			appId: app.appId,
			dependent: true,
		};
	}

	nextStepsForDependentApp(
		appId,
		availableImages,
		downloading,
		current,
		target,
		currentDevices,
		targetDevices,
		stepsInProgress,
	) {
		// - if there's current but not target, push a removeDependentApp step
		if (target == null) {
			return [
				{
					action: 'removeDependentApp',
					appId: current.appId,
				},
			];
		}

		if (_.some(stepsInProgress, (step) => step.appId === target.parentApp)) {
			return [{ action: 'noop' }];
		}

		const needsDownload =
			target.commit != null &&
			target.image != null &&
			!this._imageAvailable(target.image, availableImages);

		// - if toBeDownloaded includes this app, push a fetch step
		if (needsDownload) {
			if (_.includes(downloading, target.imageId)) {
				return [{ action: 'noop' }];
			} else {
				return [
					{
						action: 'fetch',
						appId,
						image: this.imageForDependentApp(target),
					},
				];
			}
		}

		const devicesDiffer = this._compareDevices(
			currentDevices,
			targetDevices,
			appId,
		);

		// - if current doesn't match target, or the devices differ, push an updateDependentTargets step
		if (!_.isEqual(current, target) || devicesDiffer) {
			return [
				{
					action: 'updateDependentTargets',
					devices: targetDevices,
					app: target,
					appId,
				},
			];
		}

		// if we got to this point, the current app is up to date and devices have the
		// correct targetCommit, targetEnvironment and targetConfig.
		const hookStep = this._getHookStep(currentDevices, appId);
		if (!_.isEmpty(hookStep.devices)) {
			return [hookStep];
		}
		return [];
	}

	getRequiredSteps(
		availableImages,
		downloading,
		current,
		target,
		stepsInProgress,
	) {
		return Promise.try(() => {
			const targetApps = _.keyBy(target.dependent?.apps ?? [], 'appId');
			const targetAppIds = _.keys(targetApps);
			const currentApps = _.keyBy(current.dependent?.apps ?? [], 'appId');
			const currentAppIds = _.keys(currentApps);
			const allAppIds = _.union(targetAppIds, currentAppIds);

			let steps = [];
			for (const appId of allAppIds) {
				const devicesForApp = (devices) =>
					_.filter(devices, (d) => _.has(d.apps, appId));

				const currentDevices = devicesForApp(current.dependent.devices);
				const targetDevices = devicesForApp(target.dependent.devices);
				const stepsForApp = this.nextStepsForDependentApp(
					appId,
					availableImages,
					downloading,
					currentApps[appId],
					targetApps[appId],
					currentDevices,
					targetDevices,
					stepsInProgress,
				);
				steps = steps.concat(stepsForApp);
			}
			return steps;
		});
	}

	getHookEndpoint(appId) {
		return db
			.models('dependentApp')
			.select('parentApp')
			.where({ appId })
			.then(([{ parentApp }]) => dbFormat.getApp(parseInt(parentApp, 10)))
			.then((parentApp) => {
				return Promise.map(parentApp.services ?? [], (service) => {
					return dockerUtils.getImageEnv(service.config.image);
				}).then(function (imageEnvs) {
					const imageHookAddresses = _.map(
						imageEnvs,
						(env) =>
							env.BALENA_DEPENDENT_DEVICES_HOOK_ADDRESS ??
							env.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS,
					);
					for (const addr of imageHookAddresses) {
						if (addr != null) {
							return addr;
						}
					}
					// If we don't find the hook address in the images, we take it from
					// the global config
					return deviceConfig
						.getTarget()
						.then(
							(target) =>
								target.BALENA_DEPENDENT_DEVICES_HOOK_ADDRESS ??
								target.RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS ??
								`${constants.proxyvisorHookReceiver}/v1/devices/`,
						);
				});
			});
	}

	sendUpdate(device, timeout, endpoint) {
		return Promise.resolve(request.getRequestInstance())
			.then((instance) =>
				instance.putAsync(`${endpoint}${device.uuid}`, {
					json: true,
					body: device.target,
				}),
			)
			.timeout(timeout)
			.spread((response, body) => {
				if (response.statusCode === 200) {
					return (this.acknowledgedState[device.uuid] = device.target);
				} else {
					this.acknowledgedState[device.uuid] = null;
					if (response.statusCode !== 202) {
						throw new Error(`Hook returned ${response.statusCode}: ${body}`);
					}
				}
			})
			.catch((err) => log.error(`Error updating device ${device.uuid}`, err));
	}

	sendDeleteHook({ uuid }, timeout, endpoint) {
		return Promise.resolve(request.getRequestInstance())
			.then((instance) => instance.delAsync(`${endpoint}${uuid}`))
			.timeout(timeout)
			.spread((response, body) => {
				if (response.statusCode === 200) {
					return db.models('dependentDevice').del().where({ uuid });
				} else {
					throw new Error(`Hook returned ${response.statusCode}: ${body}`);
				}
			})
			.catch((err) => log.error(`Error deleting device ${uuid}`, err));
	}

	sendUpdates({ uuid }) {
		return Promise.join(
			db.models('dependentDevice').where({ uuid }).select(),
			config.get('apiTimeout'),
			([dev], apiTimeout) => {
				if (dev == null) {
					log.warn(`Trying to send update to non-existent device ${uuid}`);
					return;
				}
				return this.normaliseDependentDeviceFromDB(dev).then((device) => {
					const currentState = formatCurrentAsState(device);
					const targetState = formatTargetAsState(device);
					return this.getHookEndpoint(device.appId).then((endpoint) => {
						if (device.markedForDeletion) {
							return this.sendDeleteHook(device, apiTimeout, endpoint);
						} else if (
							device.targetCommit != null &&
							!_.isEqual(targetState, currentState) &&
							!_.isEqual(targetState, this.acknowledgedState[device.uuid])
						) {
							return this.sendUpdate(device, apiTimeout, endpoint);
						}
					});
				});
			},
		);
	}
}

const proxyvisor = new Proxyvisor();
export default proxyvisor;
