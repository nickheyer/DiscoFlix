<script lang="ts">
	import { catalogClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import type { DatasetImport } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
	import { formatBytes, formatCount, formatShort, toDate } from '#lib/theme/format';
	import { Button } from '#lib/ui/button';
	import { Switch } from '#lib/ui/switch';
	import { datasetState } from './states';
	import StateBadge from './StateBadge.svelte';

	let { dataset, onchanged }: { dataset: DatasetImport; onchanged: () => Promise<void> } = $props();

	let busy = $state(false);
	let error = $state('');
	let workflowId = $state('');

	const running = $derived(dataset.state === 'downloading' || dataset.state === 'loading');
	const times = $derived(
		[
			{ label: 'Started', at: toDate(dataset.startedAt) },
			{ label: 'Finished', at: toDate(dataset.finishedAt) },
			{ label: 'Published', at: toDate(dataset.lastModified) }
		].filter((t) => t.at !== undefined)
	);

	// Enables or disables the dataset, the server downloads it right away when enabled
	async function importDataset(enabled: boolean): Promise<void> {
		busy = true;
		error = '';
		try {
			const res = await catalogClient.importDataset({ dataset: dataset.dataset, enabled });
			workflowId = res.workflowId;
			await onchanged();
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<li class="space-y-2 px-4 py-3">
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-semibold text-header">{dataset.title || dataset.dataset}</span>
		<span class="font-mono text-xs text-faint">{dataset.dataset}</span>
		<StateBadge {...datasetState(dataset.state)} />
		<label class="ml-auto flex items-center gap-2 text-xs text-interactive">
			Enabled
			<Switch
				aria-label="Enable {dataset.title || dataset.dataset}"
				bind:checked={() => dataset.enabled, (on) => void importDataset(on)}
				disabled={busy}
			/>
		</label>
	</div>
	<dl class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
		{#if dataset.license}
			<div class="flex gap-1.5">
				<dt class="text-faint">License</dt>
				<dd class="text-normal">{dataset.license}</dd>
			</div>
		{/if}
		<div class="flex gap-1.5">
			<dt class="text-faint">Rows</dt>
			<dd class="text-normal tabular-nums">{formatCount(dataset.rows)}</dd>
		</div>
		<div class="flex gap-1.5">
			<dt class="text-faint">Size</dt>
			<dd class="text-normal tabular-nums">{formatBytes(dataset.bytes)}</dd>
		</div>
		{#each times as t (t.label)}
			<div class="flex gap-1.5">
				<dt class="text-faint">{t.label}</dt>
				<dd class="text-normal">{formatShort(t.at)}</dd>
			</div>
		{/each}
	</dl>
	{#if dataset.error}
		<p class="rounded bg-dnd/10 px-2 py-1.5 text-xs break-words text-dnd">{dataset.error}</p>
	{/if}
	<div class="flex flex-wrap items-center gap-2">
		<Button size="sm" variant="secondary" disabled={busy || running} onclick={() => importDataset(true)}>
			{running ? 'Importing' : busy ? 'Starting' : 'Import now'}
		</Button>
		{#if workflowId}
			<span class="text-xs text-faint">Workflow <code class="font-mono text-normal">{workflowId}</code></span>
		{/if}
	</div>
	{#if error}
		<p class="text-sm text-dnd" role="alert">{error}</p>
	{/if}
</li>
