import { toJson, type JsonObject, type JsonValue } from '@bufbuild/protobuf';
import { ValueSchema, type Value } from '@bufbuild/protobuf/wkt';
import { EntityKind, type Candidate, type Claim, type Entity } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import { formatShort, humanize } from '#lib/theme/format';

export const kindOptions: { value: EntityKind; label: string }[] = [
	{ value: EntityKind.UNSPECIFIED, label: 'Any kind' },
	{ value: EntityKind.MOVIE, label: 'Movie' },
	{ value: EntityKind.SERIES, label: 'Series' },
	{ value: EntityKind.SEASON, label: 'Season' },
	{ value: EntityKind.EPISODE, label: 'Episode' }
];

const kindNames: [string, EntityKind][] = [
	['movie', EntityKind.MOVIE],
	['series', EntityKind.SERIES],
	['season', EntityKind.SEASON],
	['episode', EntityKind.EPISODE]
];

export function kindOf(name: string): EntityKind {
	return kindNames.find(([n]) => n === name)?.[1] ?? EntityKind.UNSPECIFIED;
}

export function kindName(kind: EntityKind): string {
	return kindNames.find(([, k]) => k === kind)?.[0] ?? '';
}

// Labels an enum or wire kind, humanizing kinds this client does not know yet
export function kindLabel(kind: EntityKind | string): string {
	const known = typeof kind === 'string' ? kindOf(kind) : kind;
	if (known !== EntityKind.UNSPECIFIED) return kindOptions.find((o) => o.value === known)?.label ?? 'Title';
	return typeof kind === 'string' && kind !== '' ? humanize(kind) : 'Title';
}

const namespaceLabels: Record<string, string> = {
	imdb: 'IMDb',
	tmdb: 'TMDB',
	tvdb: 'TVDB',
	wikidata: 'Wikidata',
	trakt: 'Trakt',
	letterboxd: 'Letterboxd',
	tvmaze: 'TVmaze',
	netflix: 'Netflix',
	rottentomatoes: 'Rotten Tomatoes',
	metacritic: 'Metacritic',
	anidb: 'AniDB',
	anilist: 'AniList',
	mal: 'MyAnimeList',
	douban: 'Douban',
	kinopoisk: 'Kinopoisk',
	appletv: 'Apple TV',
	plex: 'Plex',
	entity: 'Catalog entity'
};

const sourceLabels: Record<string, string> = {
	...namespaceLabels,
	fanart: 'Fanart.tv',
	tmdbexport: 'TMDB exports',
	snapshot: 'Snapshot',
	user: 'Catalog editor',
	llm: 'AI reconciler'
};

export function namespaceLabel(namespace: string): string {
	return namespaceLabels[namespace] ?? namespace;
}

export function sourceLabel(source: string): string {
	return sourceLabels[source] ?? source;
}

const fieldLabels: Record<string, string> = {
	title: 'Title',
	original_title: 'Original title',
	year: 'Year',
	release_date: 'Release date',
	overview: 'Overview',
	tagline: 'Tagline',
	runtime: 'Runtime',
	genres: 'Genres',
	status: 'Status',
	language: 'Language',
	countries: 'Countries',
	certification: 'Certification',
	homepage: 'Homepage',
	networks: 'Networks',
	first_air_date: 'First aired',
	last_air_date: 'Last aired',
	season_count: 'Seasons',
	episode_count: 'Episodes',
	air_date: 'Air date',
	ordinal: 'Number',
	popularity: 'Popularity',
	keywords: 'Keywords',
	cast: 'Cast',
	crew: 'Crew',
	collection: 'Collection',
	aliases: 'Also known as'
};

const fieldPrefixes: [string, (rest: string) => string][] = [
	['parent.xid.', (ns) => `Parent ${namespaceLabel(ns)} id`],
	['xid.', (ns) => `${namespaceLabel(ns)} id`],
	['rating.', (source) => `Rating from ${sourceLabel(source)}`],
	['votes.', (source) => `Votes on ${sourceLabel(source)}`],
	['artwork.', (kind) => `${humanize(kind)} artwork`]
];

export function fieldLabel(field: string): string {
	const known = fieldLabels[field];
	if (known) return known;
	for (const [prefix, label] of fieldPrefixes) {
		if (field.startsWith(prefix)) return label(field.slice(prefix.length));
	}
	return humanize(field) || field;
}

export interface PersonView {
	name: string;
	detail: string;
	image: string;
}

export type ValueView =
	| { type: 'empty' }
	| { type: 'bool'; value: boolean }
	| { type: 'number'; text: string }
	| { type: 'date'; text: string; iso: string }
	| { type: 'link'; href: string; text: string }
	| { type: 'text'; text: string; long: boolean }
	| { type: 'chips'; items: string[] }
	| { type: 'people'; people: PersonView[] }
	| { type: 'image'; url: string; width: number; height: number }
	| { type: 'list'; items: ValueView[] }
	| { type: 'object'; entries: { key: string; view: ValueView }[] };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const LINK = /^https?:\/\/\S+$/;
const LONG_TEXT = 160;
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function isObject(value: JsonValue): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberText(n: number, field: string): string {
	if (field === 'runtime') return `${numberFormat.format(n)} min`;
	if (Number.isInteger(n) && Math.abs(n) < 10_000) return String(n);
	return numberFormat.format(n);
}

function describeString(text: string): ValueView {
	if (DAY.test(text)) {
		const day = new Date(`${text}T00:00:00Z`);
		if (!Number.isNaN(day.getTime())) return { type: 'date', text: dayFormat.format(day), iso: text };
	}
	if (STAMP.test(text)) {
		const at = new Date(text);
		if (!Number.isNaN(at.getTime())) return { type: 'date', text: formatShort(at), iso: at.toISOString() };
	}
	if (LINK.test(text)) return { type: 'link', href: text, text: text.replace(/^https?:\/\//, '') };
	return { type: 'text', text, long: text.length > LONG_TEXT };
}

function person(value: JsonObject): PersonView {
	const character = typeof value.character === 'string' ? value.character : '';
	const role = typeof value.role === 'string' ? value.role : '';
	const image = typeof value.image === 'string' && LINK.test(value.image) ? value.image : '';
	return { name: String(value.name), detail: character ? `as ${character}` : role, image };
}

function describeObject(value: JsonObject, field: string): ValueView {
	const url = value.url;
	const sized = typeof value.width === 'number' || typeof value.height === 'number';
	if (typeof url === 'string' && LINK.test(url) && (sized || field.startsWith('artwork.'))) {
		const width = typeof value.width === 'number' ? value.width : 0;
		const height = typeof value.height === 'number' ? value.height : 0;
		return { type: 'image', url, width, height };
	}
	return { type: 'object', entries: Object.entries(value).map(([key, v]) => ({ key, view: describeValue(v, key) })) };
}

// Classifies a JSON field value so dates, links, people, images, and lists each render by type
export function describeValue(value: JsonValue, field = ''): ValueView {
	if (value === null) return { type: 'empty' };
	if (typeof value === 'boolean') return { type: 'bool', value };
	if (typeof value === 'number') return { type: 'number', text: numberText(value, field) };
	if (typeof value === 'string') return describeString(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return { type: 'empty' };
		if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
			return { type: 'chips', items: value.map((v) => String(v)) };
		}
		if (value.every((v) => isObject(v) && typeof v.name === 'string')) {
			return { type: 'people', people: value.map((v) => person(v as JsonObject)) };
		}
		return { type: 'list', items: value.map((v) => describeValue(v, field)) };
	}
	return describeObject(value, field);
}

// Reads a protobuf Value as plain JSON, null when no kind is set
export function valueJson(value: Value | undefined): JsonValue {
	if (!value || value.kind.case === undefined) return null;
	return toJson(ValueSchema, value);
}

export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
	return JSON.stringify(valueJson(a)) === JSON.stringify(valueJson(b));
}

export type PinMode = 'text' | 'number' | 'bool' | 'json';

export const pinModes: { value: PinMode; label: string }[] = [
	{ value: 'text', label: 'Text' },
	{ value: 'number', label: 'Number' },
	{ value: 'bool', label: 'Yes or no' },
	{ value: 'json', label: 'JSON' }
];

// Prefills the pin editor with the current value in the input mode matching its type
export function pinDraft(value: JsonValue): { mode: PinMode; text: string } {
	if (typeof value === 'string') return { mode: 'text', text: value };
	if (typeof value === 'number') return { mode: 'number', text: String(value) };
	if (typeof value === 'boolean') return { mode: 'bool', text: String(value) };
	return { mode: 'json', text: JSON.stringify(value, null, 2) };
}

export type PinParse = { ok: true; value: JsonValue } | { ok: false; error: string };

// Turns pin editor input into the JSON value sent to the server or explains why it is invalid
export function parsePin(mode: PinMode, text: string): PinParse {
	const trimmed = text.trim();
	switch (mode) {
		case 'text':
			return trimmed === '' ? { ok: false, error: 'Enter a value to pin' } : { ok: true, value: trimmed };
		case 'number': {
			const n = Number(trimmed);
			return trimmed === '' || !Number.isFinite(n) ? { ok: false, error: 'Enter a number' } : { ok: true, value: n };
		}
		case 'bool':
			if (trimmed === 'true') return { ok: true, value: true };
			if (trimmed === 'false') return { ok: true, value: false };
			return { ok: false, error: 'Choose yes or no' };
		case 'json':
			try {
				return { ok: true, value: JSON.parse(trimmed) as JsonValue };
			} catch {
				return { ok: false, error: 'Enter valid JSON' };
			}
	}
}

function observed(claim: Claim): bigint {
	return claim.observedAt?.seconds ?? 0n;
}

// Groups claims by field, pinned first, then by source rank, confidence, and newest observation
export function groupClaims(claims: Claim[]): Map<string, Claim[]> {
	const out = new Map<string, Claim[]>();
	for (const claim of claims) {
		const list = out.get(claim.field);
		if (list) list.push(claim);
		else out.set(claim.field, [claim]);
	}
	for (const list of out.values()) {
		list.sort(
			(a, b) =>
				Number(b.pinned) - Number(a.pinned) ||
				a.rank - b.rank ||
				b.confidence - a.confidence ||
				Number(observed(b) - observed(a))
		);
	}
	return out;
}

// Collects every source that contributed a field or an external id, sorted by name
export function entitySources(entity: Entity): string[] {
	const names = new Set([...entity.fields.map((f) => f.source), ...entity.externalIds.map((x) => x.source)]);
	names.delete('');
	return [...names].sort();
}

// Names a season or episode by its number, keeping a distinct title as the second line
export function childTitle(child: Entity): { primary: string; secondary: string } {
	if (child.kind === EntityKind.SEASON) {
		const primary = child.ordinal === 0 ? 'Specials' : `Season ${child.ordinal}`;
		return { primary, secondary: child.title && child.title !== primary ? child.title : '' };
	}
	if (child.kind === EntityKind.EPISODE) {
		const title = child.title || 'Untitled episode';
		return { primary: child.ordinal > 0 ? `${child.ordinal}. ${title}` : title, secondary: '' };
	}
	return { primary: child.title || 'Untitled', secondary: kindLabel(child.kind) };
}

export function sortChildren(children: Entity[]): Entity[] {
	return [...children].sort((a, b) => a.ordinal - b.ordinal || a.title.localeCompare(b.title));
}

export function childrenHeading(kind: EntityKind): string {
	if (kind === EntityKind.SERIES) return 'Seasons';
	if (kind === EntityKind.SEASON) return 'Episodes';
	return 'Parts';
}

// Picks the score that fills a whole bar, at least one so weak results never look perfect
export function scoreScale(candidates: Candidate[]): number {
	return Math.max(1, ...candidates.map((c) => c.score).filter((s) => Number.isFinite(s)));
}
