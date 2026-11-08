import { base64Encode } from '@bufbuild/protobuf/wire';
import { rgbaToThumbHash, thumbHashToDataURL } from 'thumbhash';
import { describe, expect, it } from 'vitest';
import { thumbhashDataUrl } from './thumbhash';

function gradient(w: number, h: number): Uint8Array {
	const rgba = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			rgba[i] = (x * 255) / (w - 1);
			rgba[i + 1] = (y * 255) / (h - 1);
			rgba[i + 2] = 128;
			rgba[i + 3] = 255;
		}
	}
	return rgba;
}

describe('thumbhashDataUrl', () => {
	const hash = rgbaToThumbHash(20, 30, gradient(20, 30));

	it('decodes standard base64 as sent by the server into the same PNG the library renders', () => {
		const url = thumbhashDataUrl(base64Encode(hash, 'std'));
		expect(url.startsWith('data:image/png;base64,')).toBe(true);
		expect(url).toBe(thumbHashToDataURL(hash));
	});

	it('accepts url safe base64 without padding', () => {
		expect(thumbhashDataUrl(base64Encode(hash, 'url'))).toBe(thumbHashToDataURL(hash));
	});

	it('returns the cached result for a repeated hash', () => {
		const text = base64Encode(hash, 'std');
		expect(thumbhashDataUrl(text)).toBe(thumbhashDataUrl(text));
	});

	it('returns empty for missing, truncated, or malformed hashes', () => {
		expect(thumbhashDataUrl('')).toBe('');
		expect(thumbhashDataUrl(base64Encode(hash.slice(0, 3), 'std'))).toBe('');
		expect(thumbhashDataUrl('***not base64***')).toBe('');
	});
});
