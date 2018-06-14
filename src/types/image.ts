export interface Image {
	id: number;
	name: string;
	appId: number;
	serviceId: number;
	serviceName: string;
	imageId: number;
	releaseId: number;
	dependent: number;
	dockerImageId: string;
	status: string;
	downloadProgress: number | null;
}

export default Image;
