import type { App } from './app';

export type InstancedAppState = { [appId: number]: App };

export type AppRelease = { appUuid: string; releaseUuid: string };
