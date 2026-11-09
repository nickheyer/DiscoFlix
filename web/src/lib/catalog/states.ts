import type { Accent } from '#lib/cards/registry';
import type { GetCatalogStatusResponse } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import { humanize } from '#lib/theme/format';

export interface StateInfo {
	label: string;
	tone: Accent;
}

type StateTable = Record<string, StateInfo>;

const outcomes: StateTable = {
	answered: { label: 'Answered', tone: 'success' },
	empty: { label: 'No results', tone: 'neutral' },
	disabled: { label: 'Disabled', tone: 'neutral' },
	unreachable: { label: 'Unreachable', tone: 'danger' },
	missing: { label: 'No data yet', tone: 'warning' },
	budget: { label: 'Over budget', tone: 'warning' },
	open: { label: 'Paused after failures', tone: 'danger' },
	skipped: { label: 'Skipped', tone: 'neutral' }
};

const sources: StateTable = {
	ok: { label: 'Working', tone: 'success' },
	failing: { label: 'Failing', tone: 'danger' },
	open: { label: 'Paused after failures', tone: 'danger' },
	disabled: { label: 'Disabled', tone: 'neutral' },
	idle: { label: 'Idle', tone: 'info' }
};

const snapshots: StateTable = {
	ready: { label: 'Ready', tone: 'success' },
	missing: { label: 'Missing', tone: 'warning' },
	updating: { label: 'Updating', tone: 'info' },
	failed: { label: 'Failed', tone: 'danger' }
};

const datasets: StateTable = {
	idle: { label: 'Idle', tone: 'neutral' },
	downloading: { label: 'Downloading', tone: 'info' },
	loading: { label: 'Loading', tone: 'info' },
	done: { label: 'Imported', tone: 'success' },
	failed: { label: 'Failed', tone: 'danger' }
};

const reports: StateTable = {
	started: { label: 'Started', tone: 'info' },
	done: { label: 'Done', tone: 'success' },
	failed: { label: 'Failed', tone: 'danger' },
	skipped: { label: 'Skipped', tone: 'neutral' }
};

function lookup(table: StateTable, state: string): StateInfo {
	return table[state] ?? { label: humanize(state) || 'Unknown', tone: 'neutral' };
}

export const outcomeState = (state: string): StateInfo => lookup(outcomes, state);
export const sourceState = (state: string): StateInfo => lookup(sources, state);
export const snapshotState = (state: string): StateInfo => lookup(snapshots, state);
export const datasetState = (state: string): StateInfo => lookup(datasets, state);
export const reportState = (state: string): StateInfo => lookup(reports, state);

// Colors a probability green when confident, blurple when plausible, amber when doubtful
export function confidenceTone(ratio: number): Accent {
	if (ratio >= 0.85) return 'success';
	if (ratio >= 0.5) return 'info';
	return 'warning';
}

// Reports whether the snapshot is updating or any dataset is still downloading or loading
export function catalogBusy(status: GetCatalogStatusResponse | undefined): boolean {
	if (!status) return false;
	if (status.snapshot?.state === 'updating') return true;
	return status.datasets.some((d) => d.state === 'downloading' || d.state === 'loading');
}
