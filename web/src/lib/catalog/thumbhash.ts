import { base64Decode } from '@bufbuild/protobuf/wire';
import { thumbHashToDataURL } from 'thumbhash';

const HEADER_BYTES = 5;
const LIMIT = 512;
const decoded = new Map<string, string>();

// Decodes a base64 thumbhash to a PNG data URL, empty when the hash is absent or malformed
export function thumbhashDataUrl(hash: string): string {
	if (hash === '') return '';
	const hit = decoded.get(hash);
	if (hit !== undefined) return hit;
	let url = '';
	try {
		const bytes = base64Decode(hash);
		if (bytes.length >= HEADER_BYTES) url = thumbHashToDataURL(bytes);
	} catch {
		url = '';
	}
	if (decoded.size >= LIMIT) decoded.delete(decoded.keys().next().value ?? '');
	decoded.set(hash, url);
	return url;
}
