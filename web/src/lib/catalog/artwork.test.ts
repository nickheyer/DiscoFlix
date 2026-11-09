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

	it('names the artwork sources and asks for a key when every one is disabled or unconfigured', () => {
		const notice = artworkNotice(
			artworkSourcesFromOutcomes([
				outcome('snapshot', 'answered', false),
				outcome('tmdb', 'disabled', true),
				outcome('fanart', 'unconfigured', true),
				outcome('tvdb', 'disabled', true)
			])
		);
		expect(notice).toEqual({
			message: 'Posters and backdrops come from TMDB, Fanart.tv and TVDB, none of which is enabled with a key.',
			needsKey: true
		});
	});

	it('blames reachability when a configured artwork source failed', () => {
		const notice = artworkNotice(
			artworkSourcesFromOutcomes([outcome('tmdb', 'unreachable', true), outcome('tvdb', 'disabled', true)])
		);
		expect(notice).toEqual({ message: 'TMDB could not be reached, so no artwork arrived.', needsKey: false });
	});

	it('reports when nothing installed offers artwork', () => {
		expect(artworkNotice(artworkSourcesFromOutcomes([outcome('snapshot', 'answered', false)]))).toEqual({
			message: 'No installed source offers posters or backdrops.',
			needsKey: false
		});
	});

	it('maps configured sources to request states', () => {
		const sources = artworkSourcesFromStatus([
			create(SourceSchema, { name: 'tmdb', artwork: true, enabled: false, configured: false, state: 'disabled' }),
			create(SourceSchema, { name: 'fanart', artwork: true, enabled: true, configured: false, state: 'unconfigured' }),
			create(SourceSchema, { name: 'tvdb', artwork: true, enabled: true, configured: true, state: 'failing' }),
			create(SourceSchema, { name: 'trakt', artwork: false, enabled: true, configured: true, state: 'ok' })
		]);
		expect(sources.map((s) => s.state)).toEqual(['disabled', 'unconfigured', 'unreachable', 'answered']);
		expect(artworkNotice(sources).message).toBe('TVDB could not be reached, so no artwork arrived.');
	});
});
