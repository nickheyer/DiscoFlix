import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { ArtworkVariantSchema, SourceSchema } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import { aspectRatio, sortVariants, srcsetFor, variantFormats } from './artwork';
import { MAX_PEERS, overBudget, parsePeers } from './config';

describe('parsePeers', () => {
	it('trims, drops blank lines, and removes duplicates', () => {
		expect(parsePeers(' https://a.example \n\nhttps://b.example\nhttps://a.example\n')).toEqual({
			peers: ['https://a.example', 'https://b.example'],
			error: ''
		});
	});

	it('enforces the server limits on count and length', () => {
		const many = Array.from({ length: MAX_PEERS + 1 }, (_, i) => `https://p${i}.example`).join('\n');
		expect(parsePeers(many).error).toBe(`Up to ${MAX_PEERS} peers are allowed`);
		expect(parsePeers(`https://${'x'.repeat(520)}`).error).toBe('Each peer address must be at most 512 characters');
	});
});

describe('overBudget', () => {
	it('is true once calls reach a positive budget', () => {
		expect(overBudget(create(SourceSchema, { callsToday: 100, budget: 100 }))).toBe(true);
		expect(overBudget(create(SourceSchema, { callsToday: 99, budget: 100 }))).toBe(false);
		expect(overBudget(create(SourceSchema, { callsToday: 5000, budget: 0 }))).toBe(false);
	});
});

describe('artwork variants', () => {
	const variants = [
		create(ArtworkVariantSchema, { format: 'webp', width: 780, url: '/a/780.webp', bytes: 50_000n }),
		create(ArtworkVariantSchema, { format: 'avif', width: 342, url: '/a/342.avif', bytes: 9_000n }),
		create(ArtworkVariantSchema, { format: 'webp', width: 342, url: '/a/342.webp', bytes: 14_000n }),
		create(ArtworkVariantSchema, { format: 'avif', width: 780, url: '/a/780.avif', bytes: 30_000n }),
		create(ArtworkVariantSchema, { format: 'jxl', width: 342, url: '/a/342.jxl' }),
		create(ArtworkVariantSchema, { format: 'png', width: 0, url: '/a/0.png' })
	];

	it('lists formats avif first and skips variants without a width', () => {
		expect(variantFormats(variants)).toEqual(['avif', 'webp', 'jxl']);
		expect(variantFormats([])).toEqual([]);
	});

	it('builds a width described srcset narrowest first', () => {
		expect(srcsetFor(variants, 'webp')).toBe('/a/342.webp 342w, /a/780.webp 780w');
		expect(srcsetFor(variants, 'gif')).toBe('');
	});

	it('orders the download list by format then width', () => {
		expect(sortVariants(variants).map((v) => v.url)).toEqual([
			'/a/342.avif',
			'/a/780.avif',
			'/a/342.webp',
			'/a/780.webp',
			'/a/0.png',
			'/a/342.jxl'
		]);
	});

	it('gives the image ratio or the fallback when the size is unknown', () => {
		expect(aspectRatio({ width: 1280, height: 720 }, '2 / 3')).toBe('1280 / 720');
		expect(aspectRatio({ width: 0, height: 720 }, '2 / 3')).toBe('2 / 3');
	});
});
