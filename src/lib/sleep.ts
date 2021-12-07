/**
 * Delays for input ms before resolving
 */
export default async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
