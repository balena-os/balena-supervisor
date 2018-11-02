// Allow importing of json files with typescript
declare module '*.json' {
	const value: { [key: string]: any };
	export default value;
}
