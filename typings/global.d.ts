interface Dictionary<T> {
	[key: string]: T;
}

type Callback<T> = (err?: Error, res?: T) => void;

type Nullable<T> = T | null | undefined;
type Resolvable<T> = T | Promise<T>;

type UnwrappedPromise = T extends PromiseLike<infer U> ? U : T;

type DeepPartial<T> = T extends object
	? { [K in keyof T]?: DeepPartial<T[K]> }
	: T;
