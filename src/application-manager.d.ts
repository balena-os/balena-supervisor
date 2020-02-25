import * as Bluebird from 'bluebird';
import { EventEmitter } from 'events';
import { Router } from 'express';
import Knex = require('knex');

import { ServiceAction } from './device-api/common';
import { EventTracker } from './event-tracker';
import { Logger } from './logger';
import { DeviceStatus, InstancedAppState } from './types/state';

import ImageManager, { Image } from './compose/images';
import ServiceManager from './compose/service-manager';
import DB from './db';
import DeviceState from './device-state';

import { APIBinder } from './api-binder';
import Config from './config';

import NetworkManager from './compose/network-manager';
import VolumeManager from './compose/volume-manager';

import {
	CompositionStep,
	CompositionStepAction,
} from './compose/composition-steps';
import Network from './compose/network';
import Service from './compose/service';
import Volume from './compose/volume';
import DockerUtils from './lib/docker-utils';

declare interface Options {
	force?: boolean;
	running?: boolean;
	skipLock?: boolean;
}

// TODO: This needs to be moved to the correct module's typings
declare interface Application {
	services: Service[];
}

// This is a non-exhaustive typing for ApplicationManager to avoid
// having to recode the entire class (and all requirements in TS).
class ApplicationManager extends EventEmitter {
	// These probably could be typed, but the types are so messy that we're
	// best just waiting for the relevant module to be recoded in typescript.
	// At least any types we can be sure of then.
	//
	// TODO: When the module which is/declares these fields is converted to
	// typecript, type the following
	public _lockingIfNecessary: any;
	public logger: Logger;
	public deviceState: DeviceState;
	public eventTracker: EventTracker;
	public apiBinder: APIBinder;
	public docker: DockerUtils;

	public services: ServiceManager;
	public volumes: VolumeManager;
	public networks: NetworkManager;
	public config: Config;
	public db: DB;
	public images: ImageManager;

	public proxyvisor: any;
	public timeSpentFetching: number;
	public fetchesInProgress: number;

	public validActions: string[];

	public router: Router;

	public constructor({
		logger: Logger,
		config: Config,
		db: DB,
		eventTracker: EventTracker,
		deviceState: DeviceState,
	});

	public init(): Promise<void>;

	public getCurrentApp(appId: number): Bluebird<Application | null>;

	// TODO: This actually returns an object, but we don't need the values just yet
	public setTargetVolatileForService(serviceId: number, opts: Options): void;

	public executeStepAction(
		serviceAction: ServiceAction,
		opts: Options,
	): Bluebird<void>;

	public setTarget(
		local: any,
		dependent: any,
		source: string,
		transaction: Knex.Transaction,
	): Promise<void>;

	public getStatus(): Promise<DeviceStatus>;
	// The return type is incompleted
	public getTargetApps(): Promise<InstancedAppState>;
	public stopAll(opts: { force?: boolean; skipLock?: boolean }): Promise<void>;

	public serviceNameFromId(serviceId: number): Bluebird<string>;
	public imageForService(svc: any): Promise<Image>;
	public getDependentTargets(): Promise<any>;
	public getCurrentForComparison(): Promise<any>;
	public getDependentState(): Promise<any>;
	public getExtraStateForComparison(current: any, target: any): Promise<any>;
	public getRequiredSteps(
		currentState: any,
		targetState: any,
		extraState: any,
		ignoreImages?: boolean,
	): Promise<Array<CompositionStep<CompositionStepAction>>>;
	public localModeSwitchCompletion(): Promise<void>;
}

export = ApplicationManager;
