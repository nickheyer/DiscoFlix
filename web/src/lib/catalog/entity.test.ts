import { create, fromJson } from '@bufbuild/protobuf';
import { timestampFromDate, ValueSchema } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import {
	CandidateSchema,
	ClaimSchema,
	EntityKind,
	EntitySchema,
	ExternalIdSchema,
	FieldValueSchema
} from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import {
	childrenHeading,
	childTitle,
	describeValue,
	entitySources,
	fieldLabel,
	groupClaims,
	kindLabel,
	kindName,
	kindOf,
	namespaceLabel,
	parsePin,
	pinDraft,
	sameValue,
	scoreScale,
	sortChildren,
	sourceLabel,
	valueJson
} from './entity';

describe('kinds', () => {
	it('maps wire names to enum values and back', () => {
		expect(kindOf('series')).toBe(EntityKind.SERIES);
		expect(kindOf('artist')).toBe(EntityKind.UNSPECIFIED);
		expect(kindName(EntityKind.EPISODE)).toBe('episode');
		expect(kindName(EntityKind.UNSPECIFIED)).toBe('');
	});

	it('labels enum and wire kinds and humanizes unknown ones', () => {
		expect(kindLabel(EntityKind.MOVIE)).toBe('Movie');
		expect(kindLabel('season')).toBe('Season');
		expect(kindLabel('release_group')).toBe('Release group');
		expect(kindLabel(EntityKind.UNSPECIFIED)).toBe('Title');
	});
});

describe('labels', () => {
	it('names namespaces and sources and passes unknown ones through', () => {
		expect(namespaceLabel('imdb')).toBe('IMDb');
		expect(namespaceLabel('mal')).toBe('MyAnimeList');
		expect(sourceLabel('fanart')).toBe('Fanart.tv');
		expect(sourceLabel('user')).toBe('Catalog editor');
		expect(sourceLabel('acme')).toBe('acme');
	});

	it('names fields including prefixed rating, votes, id, and artwork fields', () => {
		expect(fieldLabel('original_title')).toBe('Original title');
		expect(fieldLabel('rating.imdb')).toBe('Rating from IMDb');
		expect(fieldLabel('votes.tmdb')).toBe('Votes on TMDB');
		expect(fieldLabel('xid.wikidata')).toBe('Wikidata id');
		expect(fieldLabel('parent.xid.tvdb')).toBe('Parent TVDB id');
		expect(fieldLabel('artwork.poster')).toBe('Poster artwork');
		expect(fieldLabel('spoken_languages')).toBe('Spoken languages');
	});
});


describe('describeValue', () => {
	it('classifies scalars', () => {
		expect(describeValue(null)).toEqual({ type: 'empty' });
		expect(describeValue(true)).toEqual({ type: 'bool', value: true });
		expect(describeValue(1999, 'year')).toEqual({ type: 'number', text: '1999' });
		expect(describeValue(136, 'runtime')).toEqual({ type: 'number', text: '136 min' });
		expect(describeValue(1_234_567, 'votes.imdb')).toEqual({
			type: 'number',
			text: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(1_234_567)
		});
	});

	it('recognizes days, timestamps, links, and long text', () => {
		expect(describeValue('1999-03-31')).toMatchObject({ type: 'date', iso: '1999-03-31' });
		expect(describeValue('2026-11-08T04:00:00Z')).toMatchObject({ type: 'date', iso: '2026-11-08T04:00:00.000Z' });
		expect(describeValue('https://www.whatisthematrix.com')).toEqual({
			type: 'link',
			href: 'https://www.whatisthematrix.com',
			text: 'www.whatisthematrix.com'
		});
		expect(describeValue('javascript:alert(1)')).toMatchObject({ type: 'text' });
		expect(describeValue('x'.repeat(200))).toMatchObject({ type: 'text', long: true });
		expect(describeValue('Short')).toEqual({ type: 'text', text: 'Short', long: false });
	});

	it('renders scalar lists as chips and credit lists as people', () => {
		expect(describeValue(['Action', 'Science Fiction'])).toEqual({
			type: 'chips',
			items: ['Action', 'Science Fiction']
		});
		expect(describeValue([])).toEqual({ type: 'empty' });
		expect(
			describeValue([
				{ name: 'Keanu Reeves', character: 'Neo', image: 'https://img.example/k.jpg' },
				{ name: 'Lana Wachowski', role: 'Director', image: 'data:x' }
			])
		).toEqual({
			type: 'people',
			people: [
				{ name: 'Keanu Reeves', detail: 'as Neo', image: 'https://img.example/k.jpg' },
				{ name: 'Lana Wachowski', detail: 'Director', image: '' }
			]
		});
	});

	it('shows sized or artwork objects as images and other objects as entries', () => {
		expect(describeValue({ url: 'https://img.example/p.jpg', width: 500, height: 750 })).toEqual({
			type: 'image',
			url: 'https://img.example/p.jpg',
			width: 500,
			height: 750
		});
		expect(describeValue({ url: 'https://img.example/p.jpg' }, 'artwork.poster')).toMatchObject({ type: 'image' });
		expect(describeValue({ name: 'The Matrix Collection', id: 2344 })).toEqual({
			type: 'object',
			entries: [
				{ key: 'name', view: { type: 'text', text: 'The Matrix Collection', long: false } },
				{ key: 'id', view: { type: 'number', text: '2344' } }
			]
		});
		expect(describeValue([1, { a: true }])).toMatchObject({ type: 'list' });
	});
});

describe('values', () => {
	it('reads protobuf values as JSON and compares them', () => {
		const a = fromJson(ValueSchema, { title: 'x', year: 1 });
		const b = fromJson(ValueSchema, { title: 'x', year: 1 });
		expect(valueJson(a)).toEqual({ title: 'x', year: 1 });
		expect(valueJson(undefined)).toBeNull();
		expect(valueJson(create(ValueSchema))).toBeNull();
		expect(sameValue(a, b)).toBe(true);
		expect(sameValue(a, fromJson(ValueSchema, 'x'))).toBe(false);
	});

	it('drafts the pin editor in the mode of the current value', () => {
		expect(pinDraft('The Matrix')).toEqual({ mode: 'text', text: 'The Matrix' });
		expect(pinDraft(136)).toEqual({ mode: 'number', text: '136' });
		expect(pinDraft(false)).toEqual({ mode: 'bool', text: 'false' });
		expect(pinDraft(['a'])).toEqual({ mode: 'json', text: '[\n  "a"\n]' });
		expect(pinDraft(null)).toEqual({ mode: 'json', text: 'null' });
	});

	it('parses pin input per mode and explains bad input', () => {
		expect(parsePin('text', '  Matrix  ')).toEqual({ ok: true, value: 'Matrix' });
		expect(parsePin('text', '   ')).toEqual({ ok: false, error: 'Enter a value to pin' });
		expect(parsePin('number', '136.5')).toEqual({ ok: true, value: 136.5 });
		expect(parsePin('number', 'abc')).toEqual({ ok: false, error: 'Enter a number' });
		expect(parsePin('number', '')).toEqual({ ok: false, error: 'Enter a number' });
		expect(parsePin('bool', 'true')).toEqual({ ok: true, value: true });
		expect(parsePin('bool', 'maybe')).toEqual({ ok: false, error: 'Choose yes or no' });
		expect(parsePin('json', '{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
		expect(parsePin('json', '{a')).toEqual({ ok: false, error: 'Enter valid JSON' });
	});
});

describe('claims and children', () => {
	const at = (iso: string) => timestampFromDate(new Date(iso));

	it('groups claims by field with pinned, rank, confidence, and recency ordering', () => {
		const claims = [
			create(ClaimSchema, {
				id: 'old',
				field: 'title',
				rank: 1,
				confidence: 0.9,
				observedAt: at('2025-01-01T00:00:00Z')
			}),
			create(ClaimSchema, { id: 'low', field: 'title', rank: 3, confidence: 1 }),
			create(ClaimSchema, {
				id: 'new',
				field: 'title',
				rank: 1,
				confidence: 0.9,
				observedAt: at('2026-01-01T00:00:00Z')
			}),
			create(ClaimSchema, { id: 'pin', field: 'title', rank: 9, pinned: true }),
			create(ClaimSchema, { id: 'sure', field: 'title', rank: 1, confidence: 0.99 }),
			create(ClaimSchema, { id: 'year', field: 'year' })
		];
		const grouped = groupClaims(claims);
		expect(grouped.get('title')?.map((c) => c.id)).toEqual(['pin', 'sure', 'new', 'old', 'low']);
		expect(grouped.get('year')?.map((c) => c.id)).toEqual(['year']);
	});

	it('collects distinct sources from fields and external ids', () => {
		const entity = create(EntitySchema, {
			fields: [create(FieldValueSchema, { source: 'tmdb' }), create(FieldValueSchema, { source: '' })],
			externalIds: [create(ExternalIdSchema, { source: 'wikidata' }), create(ExternalIdSchema, { source: 'tmdb' })]
		});
		expect(entitySources(entity)).toEqual(['tmdb', 'wikidata']);
	});

	it('names seasons and episodes by number and sorts them', () => {
		const s0 = create(EntitySchema, { id: 'a', kind: EntityKind.SEASON, ordinal: 0, title: 'Specials' });
		const s2 = create(EntitySchema, { id: 'b', kind: EntityKind.SEASON, ordinal: 2, title: 'Season 2' });
		const s1 = create(EntitySchema, { id: 'c', kind: EntityKind.SEASON, ordinal: 1, title: 'The Beginning' });
		const e3 = create(EntitySchema, { id: 'd', kind: EntityKind.EPISODE, ordinal: 3, title: 'Pilot' });
		expect(childTitle(s0)).toEqual({ primary: 'Specials', secondary: '' });
		expect(childTitle(s2)).toEqual({ primary: 'Season 2', secondary: '' });
		expect(childTitle(s1)).toEqual({ primary: 'Season 1', secondary: 'The Beginning' });
		expect(childTitle(e3)).toEqual({ primary: '3. Pilot', secondary: '' });
		expect(sortChildren([s2, s0, s1]).map((c) => c.id)).toEqual(['a', 'c', 'b']);
		expect(childrenHeading(EntityKind.SERIES)).toBe('Seasons');
		expect(childrenHeading(EntityKind.SEASON)).toBe('Episodes');
	});

	it('scales score bars to the best score and never below one', () => {
		expect(scoreScale([])).toBe(1);
		expect(scoreScale([create(CandidateSchema, { score: 0.4 })])).toBe(1);
		expect(scoreScale([create(CandidateSchema, { score: 1.25 }), create(CandidateSchema, { score: 0.9 })])).toBe(1.25);
	});
});
