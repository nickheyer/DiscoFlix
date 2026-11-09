import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { SourceOutcomeSchema, SourceSchema } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import { artworkNotice, artworkSourcesFromOutcomes, artworkSourcesFromStatus } from './artwork';

const outcome = (source: string, state: string, artwork: boolean) =>
	create(SourceOutcomeSchema, { source, state, artwork });

describe('artworkNotice', () => {
	it('says nothing while a source that offers artwork is answering', () => {
		const sources = artworkSourcesFromOutcomes([
			outcome('snapshot', 'answered', false),
			outcome('tmdb', 'empty', true)
		]);
		expect(artworkNotice(sources).message).toBe('');
	});

	it('names the artwork sources when every one is disabled', () => {
		const notice = artworkNotice(
			artworkSourcesFromOutcomes([
				outcome('snapshot', 'answered', false),
				outcome('tmdb', 'disabled', true),
				outcome('fanart', 'disabled', true),
				outcome('tvdb', 'disabled', true)
			])
		);
		expect(notice).toEqual({
			message: 'Posters and backdrops come from TMDB, Fanart.tv and TVDB, all of which are disabled.',
			allDisabled: true
		});
	});

	it('explains a local-only search skipping every artwork source', () => {
		const notice = artworkNotice(
			artworkSourcesFromOutcomes([
				outcome('snapshot', 'answered', false),
				outcome('tmdb', 'skipped', true),
				outcome('fanart', 'skipped', true)
			])
		);
		expect(notice).toEqual({
			message: 'Posters and backdrops come from TMDB and Fanart.tv, which a local-only search skips.',
			allDisabled: false
		});
	});

	it('blames reachability when an enabled artwork source failed', () => {
		const notice = artworkNotice(
			artworkSourcesFromOutcomes([outcome('tmdb', 'unreachable', true), outcome('tvdb', 'disabled', true)])
		);
		expect(notice).toEqual({ message: 'TMDB could not be reached, so no artwork arrived.', allDisabled: false });
	});

	it('reports when nothing installed offers artwork', () => {
		expect(artworkNotice(artworkSourcesFromOutcomes([outcome('snapshot', 'answered', false)]))).toEqual({
			message: 'No installed source offers posters or backdrops.',
			allDisabled: false
		});
	});

	it('maps enabled sources to request states', () => {
		const sources = artworkSourcesFromStatus([
			create(SourceSchema, { name: 'tmdb', artwork: true, enabled: false, state: 'disabled' }),
			create(SourceSchema, { name: 'fanart', artwork: true, enabled: true, state: 'open' }),
			create(SourceSchema, { name: 'tvdb', artwork: true, enabled: true, state: 'failing' }),
			create(SourceSchema, { name: 'trakt', artwork: false, enabled: true, state: 'ok' })
		]);
		expect(sources.map((s) => s.state)).toEqual(['disabled', 'open', 'unreachable', 'answered']);
		expect(artworkNotice(sources).message).toBe('Fanart.tv and TVDB could not be reached, so no artwork arrived.');
	});
});
