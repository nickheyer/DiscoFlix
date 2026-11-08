import type { ArtworkVariant } from '#lib/gen/discoflix/catalog/v1/catalog_pb';

const FORMAT_ORDER = ['avif', 'webp'];

// Lists the encoded formats present, avif ahead of webp so browsers try the smaller one first
export function variantFormats(variants: ArtworkVariant[]): string[] {
	const present = new Set(variants.filter((v) => v.url !== '' && v.width > 0).map((v) => v.format));
	const known = FORMAT_ORDER.filter((f) => present.has(f));
	return [...known, ...[...present].filter((f) => !FORMAT_ORDER.includes(f)).sort()];
}

// Builds a width described srcset from the variants of one format, narrowest first
export function srcsetFor(variants: ArtworkVariant[], format: string): string {
	return variants
		.filter((v) => v.format === format && v.url !== '' && v.width > 0)
		.sort((a, b) => a.width - b.width)
		.map((v) => `${v.url} ${v.width}w`)
		.join(', ');
}

// Gives the CSS aspect ratio of an image, or the fallback when its size is unknown
export function aspectRatio(size: { width: number; height: number }, fallback: string): string {
	return size.width > 0 && size.height > 0 ? `${size.width} / ${size.height}` : fallback;
}

// Orders variants by format preference and then by width for the download list
export function sortVariants(variants: ArtworkVariant[]): ArtworkVariant[] {
	const rank = (format: string) => {
		const i = FORMAT_ORDER.indexOf(format);
		return i < 0 ? FORMAT_ORDER.length : i;
	};
	return [...variants].sort((a, b) => rank(a.format) - rank(b.format) || a.width - b.width);
}
