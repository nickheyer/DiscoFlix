import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
const short = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function toDate(ts: Timestamp | undefined): Date | undefined {
	return ts ? timestampDate(ts) : undefined;
}

export function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatTime(date: Date): string {
	return time.format(date);
}

export function formatDay(date: Date): string {
	return day.format(date);
}

export function formatFull(date: Date): string {
	return full.format(date);
}

export function formatShort(date: Date | undefined): string {
	return date ? short.format(date) : 'Never';
}

// Labels a message time as Today, Yesterday, or a short date followed by the clock time
export function formatStamp(date: Date, now = new Date()): string {
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (sameDay(date, now)) return `Today at ${formatTime(date)}`;
	if (sameDay(date, yesterday)) return `Yesterday at ${formatTime(date)}`;
	return short.format(date);
}

const steps: [Intl.RelativeTimeFormatUnit, number][] = [
	['second', 60],
	['minute', 60],
	['hour', 24],
	['day', 7],
	['week', 4.345],
	['month', 12],
	['year', Number.POSITIVE_INFINITY]
];

export function formatAgo(date: Date, now = new Date()): string {
	let value = (date.getTime() - now.getTime()) / 1000;
	for (const [unit, size] of steps) {
		if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
		value /= size;
	}
	return relative.format(Math.round(value), 'year');
}
