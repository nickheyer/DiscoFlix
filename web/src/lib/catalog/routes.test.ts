import { describe, expect, it } from 'vitest';
import { EntityKind } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import { entityPath, isCatalogPath, parseYear, readSearch, searchHref } from './routes';

describe('catalog paths', () => {
	it('matches the catalog and its children only', () => {
		expect(isCatalogPath('/catalog')).toBe(true);
		expect(isCatalogPath('/catalog/e/abc')).toBe(true);
		expect(isCatalogPath('/catalogue')).toBe(false);
		expect(isCatalogPath('/settings/catalog')).toBe(false);
	});

	it('builds entity links with the id escaped', () => {
		expect(entityPath('01JX')).toBe('/catalog/e/01JX');
		expect(entityPath('a/b')).toBe('/catalog/e/a%2Fb');
	});
});

describe('parseYear', () => {
	it('accepts blank as no year and rejects text or out of range values', () => {
		expect(parseYear('')).toBe(0);
		expect(parseYear(' 1999 ')).toBe(1999);
		expect(parseYear('0')).toBeNaN();
		expect(parseYear('2201')).toBeNaN();
		expect(parseYear('99a')).toBeNaN();
		expect(parseYear('-5')).toBeNaN();
	});
});

describe('search links', () => {
	it('round trips every form field through the query string', () => {
		const search = {
			query: 'The Matrix',
			kind: EntityKind.MOVIE,
			year: 1999,
			localOnly: true,
			mode: 'find' as const
		};
		const href = searchHref(search);
		expect(href).toBe('/catalog?q=The+Matrix&kind=movie&year=1999&local=1&mode=find');
		expect(readSearch(new URL(href, 'http://x').searchParams)).toEqual(search);
	});

	it('omits defaults and falls back on unknown values', () => {
		expect(searchHref({ query: '', kind: EntityKind.UNSPECIFIED, year: 0, localOnly: false, mode: 'search' })).toBe(
			'/catalog'
		);
		expect(readSearch(new URLSearchParams('q=%20dune%20&kind=artist&year=abc&local=yes&mode=other'))).toEqual({
			query: 'dune',
			kind: EntityKind.UNSPECIFIED,
			year: 0,
			localOnly: false,
			mode: 'search'
		});
	});
});
