interface Dictionary<T> {
	[key: string]: T;
}

interface Callback<T> {
	(err?: Error, res?: T): void;
}

type Nullable<T> = T | null | undefined;
