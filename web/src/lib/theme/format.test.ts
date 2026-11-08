import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount, formatDuration, formatPercent, humanize, percent, plural } from './format';

describe('formatBytes', () => {
	it('keeps bytes under a thousand whole', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(999)).toBe('999 B');
		expect(formatBytes(-5)).toBe('0 B');
	});

	it('steps to the next unit before showing four digits', () => {
		expect(formatBytes(1000)).toBe('1.0 KB');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(1_048_575)).toBe('1.0 MB');
	});

	it('drops the decimal from ten upward and accepts bigint', () => {
		expect(formatBytes(10n * 1024n * 1024n)).toBe('10 MB');
		expect(formatBytes(5n * 1024n ** 3n)).toBe('5.0 GB');
		expect(formatBytes(2n * 1024n ** 6n)).toBe('2048 PB');
	});
});

describe('formatDuration', () => {
	it('writes short spans in milliseconds and seconds', () => {
		expect(formatDuration(0)).toBe('0 ms');
		expect(formatDuration(850)).toBe('850 ms');
		expect(formatDuration(4200n)).toBe('4.2 s');
		expect(formatDuration(42_000)).toBe('42 s');
	});

	it('rolls over to minutes before rounding to sixty seconds', () => {
		expect(formatDuration(59_600)).toBe('1 min');
		expect(formatDuration(192_000)).toBe('3 min 12 s');
	});

	it('writes hours with minutes', () => {
		expect(formatDuration(3_600_000)).toBe('1 h');
		expect(formatDuration(3_900_000n)).toBe('1 h 5 min');
	});
});

describe('percent', () => {
	it('clamps ratios and treats non-finite values as zero', () => {
		expect(percent(0.924)).toBe(92);
		expect(percent(1.37)).toBe(100);
		expect(percent(-0.2)).toBe(0);
		expect(percent(Number.NaN)).toBe(0);
		expect(formatPercent(0.5)).toBe('50%');
	});
});

describe('counts and labels', () => {
	it('formats counts with the locale and pluralizes nouns', () => {
		expect(formatCount(1_234_567n)).toBe(new Intl.NumberFormat().format(1_234_567));
		expect(plural(1, 'result')).toBe('1 result');
		expect(plural(0, 'result')).toBe('0 results');
		expect(plural(2n, 'entity', 'entities')).toBe('2 entities');
	});

	it('humanizes snake and dotted identifiers', () => {
		expect(humanize('original_title')).toBe('Original title');
		expect(humanize('rating.imdb')).toBe('Rating imdb');
		expect(humanize('')).toBe('');
	});
});
