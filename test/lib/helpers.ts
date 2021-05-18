/**
 * Delays for input ms before resolving
 */
export async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
