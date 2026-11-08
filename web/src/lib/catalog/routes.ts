import { EntityKind } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import { kindName, kindOf } from './entity';

export type SearchMode = 'search' | 'find';

export interface SearchParams {
	query: string;
	kind: EntityKind;
	year: number;
	localOnly: boolean;
	mode: SearchMode;
}

export const MAX_YEAR = 2200;

export interface QueryParams {
	get(name: string): string | null;
}

export function isCatalogPath(path: string): boolean {
	return path === '/catalog' || path.startsWith('/catalog/');
}

export function entityPath(id: string): string {
	return `/catalog/e/${encodeURIComponent(id)}`;
}

// Reads a year typed by a person, zero when blank and NaN when out of range or not a number
export function parseYear(text: string): number {
	const trimmed = text.trim();
	if (trimmed === '') return 0;
	if (!/^\d{1,4}$/.test(trimmed)) return Number.NaN;
	const year = Number(trimmed);
	return year >= 1 && year <= MAX_YEAR ? year : Number.NaN;
}

// Restores the search form state from the catalog page query string
export function readSearch(params: QueryParams): SearchParams {
	const year = parseYear(params.get('year') ?? '');
	return {
		query: (params.get('q') ?? '').trim(),
		kind: kindOf(params.get('kind') ?? ''),
		year: Number.isNaN(year) ? 0 : year,
		localOnly: params.get('local') === '1',
		mode: params.get('mode') === 'find' ? 'find' : 'search'
	};
}

// Writes search form state into a shareable catalog page link
export function searchHref(search: SearchParams): string {
	const params = new URLSearchParams();
	if (search.query) params.set('q', search.query);
	const kind = kindName(search.kind);
	if (kind) params.set('kind', kind);
	if (search.year > 0) params.set('year', String(search.year));
	if (search.localOnly) params.set('local', '1');
	if (search.mode === 'find') params.set('mode', 'find');
	const qs = params.toString();
	return qs ? `/catalog?${qs}` : '/catalog';
}
