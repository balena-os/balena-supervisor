interface Dictionary<T> {
	[key: string]: T;
}

interface Callback<T> {
	(err?: Error, res?: T): void;
}

type Nullable<T> = T | null | undefined;

type Omit<T extends object, U extends keyof T> = Pick<T, Exclude<keyof T, U>>;
