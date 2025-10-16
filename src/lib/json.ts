function isObject(value: unknown): value is object {
	return typeof value === 'object' && value !== null;
}

/**
 * Calculates deep equality between javascript
 * objects
 */
export function equals<T>(value: T, other: T): boolean {
	if (isObject(value) && isObject(other)) {
		const [vProps, oProps] = [value, other].map(
			(a) => Object.getOwnPropertyNames(a) as Array<keyof T>,
		);
		if (vProps.length !== oProps.length) {
			// If the property lists are different lengths we don't need
			// to check any further
			return false;
		}

		// Otherwise this comparison will catch it. This works even
		// for arrays as getOwnPropertyNames returns the list of indexes
		// for each array
		return vProps.every((key) => equals(value[key], other[key]));
	}

	return value === other;
}

/**
 * Returns true if the the object equals `{}` or is an empty
 * array
 */
export function empty<T extends object>(value: T): boolean {
	return (Array.isArray(value) && value.length === 0) || equals(value, {});
}

/**
 * Calculate the difference between the dst object and src object
 * and return both the object and whether there are any changes
 */
function diffcmp<T>(src: T, tgt: T, depth = Infinity): [Partial<T>, boolean] {
	if (!isObject(src) || !isObject(tgt)) {
		// Always returns tgt in this case, but let the caller
		// know if there have been any changes
		return [tgt, src !== tgt];
	}

	// Compare arrays when reporting differences
	if (Array.isArray(src) || Array.isArray(tgt) || depth === 0) {
		return [tgt, !equals(src, tgt)];
	}

	const r = (Object.getOwnPropertyNames(tgt) as Array<keyof T>)
		.map((key) => {
			const [delta, changed] = diffcmp(src[key], tgt[key], depth - 1);
			return changed ? { [key]: delta } : {};
		})
		.concat(
			(Object.getOwnPropertyNames(src) as Array<keyof T>).map((key) => {
				const [delta, changed] = diffcmp(src[key], tgt[key], depth - 1);
				return changed ? { [key]: delta } : {};
			}),
		)
		.reduce<Partial<T>>((res, delta) => ({ ...res, ...delta }), {});

	return [r, Object.keys(r).length > 0];
}

/**
 * Calculate the difference between the target object and the source object.
 *
 * This considers both additive and substractive differences. If both the source
 * and target elements are arrays, it returns the value of the target array
 * (no array comparison)
 * e.g.
 * ```
 * // Returns `{b:2}`
 * diff({a:1}, {a: 1, b:2})
 *
 * // Returns `{b: undefined}`
 * diff({a:1, b:2}, {a: 1})
 * ```
 */
export function diff<T>(src: T, tgt: T): Partial<T> {
	const [res] = diffcmp(src, tgt);
	return res;
}

/**
 * Calulate the difference between the target object and the source
 * object up to the given depth.
 *
 * If depth is 0, it compares using `equals` and return the target if they are
 * different
 *
 * shallowDiff(src,tgt, Infinity) return the same result as diff(src, tgt)
 */
export function shallowDiff<T>(src: T, tgt: T, depth = 1): Partial<T> {
	const [res] = diffcmp(src, tgt, depth);
	return res;
}

/**
 * Removes empty branches from the json object
 *
 * e.g.
 * ```
 * prune({a: 1, b: {}})
 * // Returns `{a: 1}`
 * prune({a: 1, b: {}})
 *
 * // Returns `{a: 1, b: {c:1}}`
 * prune({a: 1, b: {c: 1, d: {}}})
 * ```
 */
export function prune<T>(obj: T): Partial<T> {
	if (!isObject(obj) || Array.isArray(obj)) {
		return obj;
	}

	return (Object.getOwnPropertyNames(obj) as Array<keyof T>)
		.map((key) => {
			const prunedChild = prune(obj[key]);
			if (
				isObject(obj[key]) &&
				!Array.isArray(obj) &&
				equals(prunedChild, {})
			) {
				return {};
			}
			return { [key]: prunedChild };
		})
		.reduce<Partial<T>>((res, delta) => ({ ...res, ...delta }), {});
}
