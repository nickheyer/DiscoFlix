import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { anyPack, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { beforeAll, describe, expect, it } from 'vitest';
import { typeRegistry } from '#lib/api/types';
import {
	CatalogReportSchema,
	EntityCardSchema,
	MatchReviewSchema,
	MatchState
} from '#lib/gen/discoflix/card/v1/catalog_pb';
import { registerBuiltinCards } from './builtin';
import {
	entityAccent,
	entitySummary,
	reportAccent,
	reportSummary,
	reviewAccent,
	reviewActions,
	reviewStateLabel,
	reviewSummary
} from './catalog-summaries';
import { cardAccent, cardActions, cardSummary, rendererFor, resolveCard, typeUrlOf } from './registry';

const review = (state: MatchState, extra: MessageInitShape<typeof MatchReviewSchema> = {}) =>
	create(MatchReviewSchema, {
		entityTitle: 'The Matrix',
		entityYear: 1999,
		candidateTitle: 'Matrix',
		candidateYear: 1999,
		state,
		...extra
	});

describe('entity cards', () => {
	it('summarizes by title and year', () => {
		expect(entitySummary(create(EntityCardSchema, { title: 'Dune', year: 2021 }))).toBe('Dune (2021)');
		expect(entitySummary(create(EntityCardSchema, { title: 'Dune' }))).toBe('Dune');
		expect(entitySummary(create(EntityCardSchema))).toBe('An untitled entry');
		expect(entityAccent()).toBe('info');
	});
});

describe('match reviews', () => {
	it('asks while pending and reports the decision afterwards', () => {
		expect(reviewSummary(review(MatchState.PENDING))).toBe('Is The Matrix (1999) the same title as Matrix (1999)?');
		expect(reviewSummary(review(MatchState.ACCEPTED))).toBe('The Matrix (1999) matched Matrix (1999)');
		expect(reviewSummary(review(MatchState.REJECTED))).toBe('The Matrix (1999) kept apart from Matrix (1999)');
		expect(reviewSummary(review(MatchState.UNSPECIFIED, { entityTitle: '' }))).toBe(
			'Match review for an untitled entry (1999)'
		);
	});

	it('uses warning while pending, success when accepted, neutral when rejected', () => {
		expect(reviewAccent(review(MatchState.PENDING))).toBe('warning');
		expect(reviewAccent(review(MatchState.ACCEPTED))).toBe('success');
		expect(reviewAccent(review(MatchState.REJECTED))).toBe('neutral');
		expect(reviewAccent(review(MatchState.UNSPECIFIED))).toBe('neutral');
	});

	it('offers the server interactor actions only while pending', () => {
		expect(reviewActions(review(MatchState.PENDING))).toEqual([
			{ id: 'accept', label: 'Same title', style: 'success' },
			{ id: 'reject', label: 'Different', style: 'danger' }
		]);
		expect(reviewActions(review(MatchState.ACCEPTED))).toEqual([]);
		expect(reviewActions(review(MatchState.REJECTED))).toEqual([]);
	});

	it('names who decided', () => {
		const decidedAt = timestampFromDate(new Date('2026-11-08T00:00:00Z'));
		expect(reviewStateLabel(review(MatchState.PENDING))).toBe('Waiting for a catalog editor');
		expect(reviewStateLabel(review(MatchState.ACCEPTED, { decidedByName: 'Nick', decidedAt }))).toBe(
			'Accepted as the same title by Nick'
		);
		expect(reviewStateLabel(review(MatchState.REJECTED, { decidedBy: 'u_1' }))).toBe(
			'Rejected as a different title by u_1'
		);
	});
});

describe('catalog reports', () => {
	const report = (kind: string, state: string, extra: { name?: string; version?: string } = {}) =>
		create(CatalogReportSchema, { kind, state, ...extra });

	it('phrases snapshot reports with the version', () => {
		expect(reportSummary(report('snapshot', 'started', { name: 'crosswalk' }))).toBe('Checking for a newer snapshot');
		expect(reportSummary(report('snapshot', 'done', { version: '2026.45' }))).toBe('Snapshot 2026.45 installed');
		expect(reportSummary(report('snapshot', 'skipped', { version: '2026.45' }))).toBe(
			'Snapshot 2026.45 is already current'
		);
		expect(reportSummary(report('snapshot', 'failed'))).toBe('Snapshot update failed');
	});

	it('phrases dataset, refresh, and source reports with the name', () => {
		expect(reportSummary(report('dataset', 'started', { name: 'IMDb datasets' }))).toBe('Importing IMDb datasets');
		expect(reportSummary(report('dataset', 'done', { name: 'IMDb datasets' }))).toBe('Imported IMDb datasets');
		expect(reportSummary(report('refresh', 'failed', { name: 'Dune' }))).toBe('Refresh of Dune failed');
		expect(reportSummary(report('refresh', 'done'))).toBe('Refreshed an entity');
		expect(reportSummary(report('source', 'failed', { name: 'tmdb' }))).toBe('TMDB is failing');
		expect(reportSummary(report('source', 'done', { name: 'fanart' }))).toBe('Fanart.tv recovered');
		expect(reportSummary(report('artwork', 'done', { name: 'posters' }))).toBe('Artwork posters done');
	});

	it('uses danger for failed, success for done, info for started, neutral for skipped', () => {
		expect(reportAccent(report('dataset', 'failed'))).toBe('danger');
		expect(reportAccent(report('dataset', 'done'))).toBe('success');
		expect(reportAccent(report('snapshot', 'started'))).toBe('info');
		expect(reportAccent(report('snapshot', 'skipped'))).toBe('neutral');
	});
});

describe('registration', () => {
	beforeAll(() => registerBuiltinCards());

	it('registers all three catalog card types for decoding and rendering', () => {
		for (const schema of [EntityCardSchema, MatchReviewSchema, CatalogReportSchema]) {
			expect(rendererFor(typeUrlOf(schema.typeName))?.schema).toBe(schema);
			expect(typeRegistry.getMessage(schema.typeName)).toBe(schema);
		}
	});

	it('resolves a packed pending review with its summary, accent, and actions', () => {
		const resolved = resolveCard(anyPack(MatchReviewSchema, review(MatchState.PENDING)));
		expect(resolved.kind).toBe('known');
		expect(cardSummary(resolved)).toBe('Is The Matrix (1999) the same title as Matrix (1999)?');
		expect(cardAccent(resolved)).toBe('warning');
		expect(cardActions(resolved).map((a) => a.id)).toEqual(['accept', 'reject']);
	});

	it('resolves a failed report as danger with no actions', () => {
		const card = create(CatalogReportSchema, { kind: 'dataset', name: 'x', state: 'failed' });
		const resolved = resolveCard(anyPack(CatalogReportSchema, card));
		expect(cardSummary(resolved)).toBe('Import of x failed');
		expect(cardAccent(resolved)).toBe('danger');
		expect(cardActions(resolved)).toEqual([]);
	});
});
