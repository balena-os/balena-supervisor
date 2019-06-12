declare module 'mknod' {
	function mknod(
		path: string,
		mode: number,
		device: number,
		cb: (err?: Error) => void,
	);

	export = mknod;
}
