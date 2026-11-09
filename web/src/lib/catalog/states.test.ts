import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
	DatasetImportSchema,
	GetCatalogStatusResponseSchema,
	SnapshotSchema
} from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import {
	catalogBusy,
	confidenceTone,
	datasetState,
	outcomeState,
	reportState,
	snapshotState,
	sourceState
} from './states';

describe('state tables', () => {
	it('labels every outcome a source can report while answering', () => {
		expect(outcomeState('answered')).toEqual({ label: 'Answered', tone: 'success' });
		expect(outcomeState('disabled')).toEqual({ label: 'Disabled', tone: 'neutral' });
		expect(outcomeState('unreachable')).toEqual({ label: 'Unreachable', tone: 'danger' });
		expect(outcomeState('missing')).toEqual({ label: 'No data yet', tone: 'warning' });
		expect(outcomeState('skipped').tone).toBe('neutral');
		expect(outcomeState('budget').tone).toBe('warning');
		expect(outcomeState('open').tone).toBe('danger');
		expect(outcomeState('empty').label).toBe('No results');
	});

	it('labels source, snapshot, dataset, and report states', () => {
		expect(sourceState('ok')).toEqual({ label: 'Working', tone: 'success' });
		expect(sourceState('failing').tone).toBe('danger');
		expect(sourceState('idle').tone).toBe('info');
		expect(snapshotState('updating')).toEqual({ label: 'Updating', tone: 'info' });
		expect(snapshotState('missing').tone).toBe('warning');
		expect(datasetState('done')).toEqual({ label: 'Imported', tone: 'success' });
		expect(datasetState('loading').tone).toBe('info');
		expect(reportState('failed').tone).toBe('danger');
		expect(reportState('skipped').tone).toBe('neutral');
	});

	it('humanizes states it does not know as neutral', () => {
		expect(sourceState('rate_limited')).toEqual({ label: 'Rate limited', tone: 'neutral' });
		expect(datasetState('')).toEqual({ label: 'Unknown', tone: 'neutral' });
	});
});

describe('confidenceTone', () => {
	it('splits probabilities into confident, plausible, and doubtful', () => {
		expect(confidenceTone(0.97)).toBe('success');
		expect(confidenceTone(0.85)).toBe('success');
		expect(confidenceTone(0.6)).toBe('info');
		expect(confidenceTone(0.2)).toBe('warning');
	});
});

describe('catalogBusy', () => {
	it('is true while the snapshot updates or a dataset downloads or loads', () => {
		expect(catalogBusy(undefined)).toBe(false);
		const idle = create(GetCatalogStatusResponseSchema, {
			snapshot: create(SnapshotSchema, { state: 'ready' }),
			datasets: [create(DatasetImportSchema, { state: 'done' })]
		});
		expect(catalogBusy(idle)).toBe(false);
		expect(
			catalogBusy(create(GetCatalogStatusResponseSchema, { snapshot: create(SnapshotSchema, { state: 'updating' }) }))
		).toBe(true);
		for (const state of ['downloading', 'loading']) {
			expect(
				catalogBusy(create(GetCatalogStatusResponseSchema, { datasets: [create(DatasetImportSchema, { state })] }))
			).toBe(true);
		}
	});
});
