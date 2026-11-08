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

const count = new Intl.NumberFormat();
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatCount(value: bigint | number): string {
	return count.format(value);
}

// Writes a count with its noun, singular only for exactly one
export function plural(value: bigint | number, one: string, many = `${one}s`): string {
	return `${formatCount(value)} ${Number(value) === 1 ? one : many}`;
}

// Scales bytes by 1024 until under a thousand, one decimal below ten
export function formatBytes(value: bigint | number): string {
	let n = Math.max(0, Number(value));
	let unit = 0;
	while (n >= 1000 && unit < BYTE_UNITS.length - 1) {
		n /= 1024;
		unit++;
	}
	if (unit === 0) return `${Math.round(n)} B`;
	return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${BYTE_UNITS[unit]}`;
}

// Writes milliseconds as ms, seconds, minutes with seconds, or hours with minutes
export function formatDuration(value: bigint | number): string {
	const ms = Math.max(0, Number(value));
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 59_500) {
		const s = ms / 1000;
		return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
	}
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
	return s > 0 ? `${m} min ${s} s` : `${m} min`;
}

// Clamps a ratio into 0 to 1 and returns whole percent points
export function percent(ratio: number): number {
	if (!Number.isFinite(ratio)) return 0;
	return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

export function formatPercent(ratio: number): string {
	return `${percent(ratio)}%`;
}

// Turns snake case or dotted identifiers into a capitalized phrase
export function humanize(text: string): string {
	const spaced = text.replace(/[_.]+/g, ' ').trim();
	return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : '';
}
