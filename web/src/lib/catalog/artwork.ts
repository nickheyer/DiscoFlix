import type { ArtworkVariant, Source, SourceOutcome } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import { sourceLabel } from './entity';

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

export interface ArtworkSource {
	source: string;
	artwork: boolean;
	state: string;
}

export interface ArtworkNotice {
	message: string;
	// Every artwork source is switched off, so an administrator can fix it in settings
	allDisabled: boolean;
}

const WORKING = new Set(['answered', 'empty']);
const DOWN = new Set(['unreachable', 'open', 'budget']);

export function artworkSourcesFromOutcomes(outcomes: SourceOutcome[]): ArtworkSource[] {
	return outcomes.map((o) => ({ source: o.source, artwork: o.artwork, state: o.state }));
}

// Reads the configured sources the way a request would see them
export function artworkSourcesFromStatus(sources: Source[]): ArtworkSource[] {
	return sources.map((s) => {
		let state = 'answered';
		if (!s.enabled) state = 'disabled';
		else if (s.state === 'open') state = 'open';
		else if (s.state === 'failing') state = 'unreachable';
		return { source: s.name, artwork: s.artwork, state };
	});
}

// Joins names as prose with commas and a final and
function joinNames(names: string[]): string {
	if (names.length <= 1) return names.join('');
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Explains why no posters can appear, empty when a source that offers artwork is working
export function artworkNotice(sources: ArtworkSource[]): ArtworkNotice {
	const capable = sources.filter((s) => s.artwork);
	if (capable.length === 0) {
		return { message: 'No installed source offers posters or backdrops.', allDisabled: false };
	}
	if (capable.some((s) => WORKING.has(s.state))) return { message: '', allDisabled: false };
	const names = joinNames(capable.map((s) => sourceLabel(s.source)));
	const down = capable.filter((s) => DOWN.has(s.state));
	if (down.length > 0) {
		return {
			message: `${joinNames(down.map((s) => sourceLabel(s.source)))} could not be reached, so no artwork arrived.`,
			allDisabled: false
		};
	}
	if (capable.every((s) => s.state === 'skipped')) {
		return {
			message: `Posters and backdrops come from ${names}, which a local-only search skips.`,
			allDisabled: false
		};
	}
	return { message: `Posters and backdrops come from ${names}, all of which are disabled.`, allDisabled: true };
}
