interface Dictionary<T> {
	[key: string]: T;
}

type Callback<T> = (err?: Error, res?: T) => void;

type Nullable<T> = T | null | undefined;
