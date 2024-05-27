export interface Image {
	id?: number;
	/**
	 * image [registry/]repo@digest or [registry/]repo:tag
	 */
	name: string;
	/**
	 * @deprecated to be removed in target state v4
	 */
	appId: number;
	appUuid: string;
	/**
	 * @deprecated to be removed in target state v4
	 */
	serviceId: number;
	serviceName: string;
	/**
	 * @deprecated to be removed in target state v4
	 */
	imageId: number;
	/**
	 * @deprecated to be removed in target state v4
	 */
	releaseId: number;
	commit: string;
	dockerImageId?: string;
	status?: 'Downloading' | 'Downloaded' | 'Deleting';
	downloadProgress?: number | null;
}
