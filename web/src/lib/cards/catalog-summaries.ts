import { sourceLabel } from '#lib/catalog/entity';
import {
	MatchState,
	type CatalogReport,
	type EntityCard,
	type MatchReview
} from '#lib/gen/discoflix/card/v1/catalog_pb';
import { humanize } from '#lib/theme/format';
import type { Accent, CardAction } from './registry';

function titled(title: string, year: number): string {
	const name = title || 'an untitled entry';
	return year > 0 ? `${name} (${year})` : name;
}

function sentence(text: string): string {
	return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export function entitySummary(card: EntityCard): string {
	return sentence(titled(card.title, card.year));
}

export function entityAccent(): Accent {
	return 'info';
}

export function reviewSummary(card: MatchReview): string {
	const entity = titled(card.entityTitle, card.entityYear);
	const candidate = titled(card.candidateTitle, card.candidateYear);
	switch (card.state) {
		case MatchState.PENDING:
			return sentence(`Is ${entity} the same title as ${candidate}?`);
		case MatchState.ACCEPTED:
			return sentence(`${entity} matched ${candidate}`);
		case MatchState.REJECTED:
			return sentence(`${entity} kept apart from ${candidate}`);
		default:
			return sentence(`Match review for ${entity}`);
	}
}

export function reviewAccent(card: MatchReview): Accent {
	switch (card.state) {
		case MatchState.PENDING:
			return 'warning';
		case MatchState.ACCEPTED:
			return 'success';
		default:
			return 'neutral';
	}
}

// Offers accept and reject while the review is pending, matching the server interactor
export function reviewActions(card: MatchReview): CardAction[] {
	if (card.state !== MatchState.PENDING) return [];
	return [
		{ id: 'accept', label: 'Same title', style: 'success' },
		{ id: 'reject', label: 'Different', style: 'danger' }
	];
}

export function reviewStateLabel(card: MatchReview): string {
	const by = card.decidedByName || card.decidedBy || 'a catalog editor';
	switch (card.state) {
		case MatchState.PENDING:
			return 'Waiting for a catalog editor';
		case MatchState.ACCEPTED:
			return `Accepted as the same title by ${by}`;
		case MatchState.REJECTED:
			return `Rejected as a different title by ${by}`;
		default:
			return 'Unknown state';
	}
}

const reportSubjects: Record<string, string> = {
	snapshot: 'the crosswalk snapshot',
	dataset: 'a dataset',
	refresh: 'an entity',
	source: 'a source'
};

// Phrases a snapshot, dataset, refresh, or source report by its kind and state
export function reportSummary(card: CatalogReport): string {
	const name = card.name || reportSubjects[card.kind] || 'the catalog';
	const version = card.version ? ` ${card.version}` : '';
	switch (card.kind) {
		case 'snapshot':
			if (card.state === 'started') return 'Checking for a newer snapshot';
			if (card.state === 'done') return `Snapshot${version} installed`;
			if (card.state === 'failed') return 'Snapshot update failed';
			if (card.state === 'skipped') return `Snapshot${version} is already current`;
			break;
		case 'dataset':
			if (card.state === 'started') return `Importing ${name}`;
			if (card.state === 'done') return `Imported ${name}`;
			if (card.state === 'failed') return `Import of ${name} failed`;
			if (card.state === 'skipped') return `Import of ${name} skipped`;
			break;
		case 'refresh':
			if (card.state === 'started') return `Refreshing ${name}`;
			if (card.state === 'done') return `Refreshed ${name}`;
			if (card.state === 'failed') return `Refresh of ${name} failed`;
			if (card.state === 'skipped') return `Refresh of ${name} skipped`;
			break;
		case 'source': {
			const source = card.name ? sourceLabel(card.name) : name;
			if (card.state === 'failed') return sentence(`${source} is failing`);
			if (card.state === 'done') return sentence(`${source} recovered`);
			break;
		}
	}
	const kind = humanize(card.kind) || 'Catalog';
	const state = humanize(card.state).toLowerCase() || 'reported';
	return card.name ? `${kind} ${card.name} ${state}` : `${kind} ${state}`;
}

export function reportAccent(card: CatalogReport): Accent {
	switch (card.state) {
		case 'failed':
			return 'danger';
		case 'done':
			return 'success';
		case 'started':
			return 'info';
		default:
			return 'neutral';
	}
}

export const reportKindLabels: Record<string, string> = {
	snapshot: 'Snapshot update',
	dataset: 'Dataset import',
	refresh: 'Entity refresh',
	source: 'Source health'
};
