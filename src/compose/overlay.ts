import { Service, ServiceStatus } from './service';

import * as dockerode from 'dockerode';
import { checkInt } from '../lib/validation';
import { InternalInconsistencyError } from '../lib/errors';

export class Overlay {
	public appId: number;
	public appName?: string;
	public imageId: number;
	public serviceId: number;
	public serviceName: string;
	public releaseId: number;
	public releaseVersion: string;
	public imageName: string | null;
	public uuid: string;

	public containerId?: string;
	public dockerImageId?: string;
	public createdAt?: Date;
	public status?: ServiceStatus;

	private constructor() {}

	public static fromDockerContainer(container: dockerode.ContainerInfo) {
		const overlay = new Overlay();

		const { Labels } = container;

		const appId = checkInt(Labels['io.balena.app-id']);
		if (appId == null) {
			throw new InternalInconsistencyError(
				`Found a service with no appId! ${overlay}`,
			);
		}

		overlay.appId = appId;
		overlay.uuid = Labels['io.balena.app-uuid'];
		overlay.serviceName = Labels['io.balena.service-name'];
		overlay.serviceId = parseInt(Labels['io.balena.service-id'], 10) || 0;
		overlay.releaseId = parseInt(Labels['io.balena.release-id'], 10) || 0;
		overlay.releaseVersion = Labels['io.balena.release-version'];
		overlay.imageName = container.Image;
		overlay.containerId = container.Id;
		overlay.dockerImageId = container.ImageID;
		overlay.createdAt = new Date(container.Created);

		return overlay;
	}

	public static fromService(service: Service, appName?: string) {
		const overlay = new Overlay();

		overlay.appId = service.appId;
		overlay.appName = appName;
		overlay.imageId = service.imageId;
		overlay.releaseId = service.releaseId;
		overlay.serviceId = service.serviceId;
		overlay.serviceName = service.serviceName!;
		overlay.releaseVersion = service.releaseVersion;
		overlay.imageName = service.imageName;
		overlay.uuid = service.uuid!;

		return overlay;
	}

	public toComposeObject() {
		const { serviceName, imageName } = this;
		const labels = {
			'io.balena.image.class': 'overlay',
			'io.balena.image.store': 'data',
			'io.balena.image.requires-reboot': '1',
		};

		return { serviceName, image: imageName, labels };
	}
}

export default Overlay;
