declare module 'blinking' {

	interface Pattern {
		blinks?: number;
		onDuration?: number;
		offDuration?: number;
		pause?: number;
	}

	interface Blink {
		start: (pattern: Pattern) => void
		stop: () => void;
	}

	function blinking(ledFile: string): Blink;

	export = blinking;
}
