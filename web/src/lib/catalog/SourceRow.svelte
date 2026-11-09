<script lang="ts">
	import { catalogClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import type { Source } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
	import { formatAgo, formatCount, formatFull, toDate } from '#lib/theme/format';
	import { Switch } from '#lib/ui/switch';
	import { overBudget } from './config';
	import { namespaceLabel } from './entity';
	import { sourceState } from './states';
	import StateBadge from './StateBadge.svelte';

	let { source, onsaved }: { source: Source; onsaved: () => Promise<void> } = $props();

	let busy = $state(false);
	let error = $state('');

	const lastOk = $derived(toDate(source.lastOkAt));
	const lastFailed = $derived(toDate(source.lastErrorAt));
	const spent = $derived(overBudget(source));

	// Sends enablement with the stored options so nothing configured is lost
	async function toggle(enabled: boolean): Promise<void> {
		busy = true;
		error = '';
		try {
			await catalogClient.configureSource({ source: source.name, enabled, options: { ...source.options } });
			await onsaved();
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<li class="space-y-3 px-4 py-3">
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-semibold text-header">{source.title || source.name}</span>
		<span class="font-mono text-xs text-faint">{source.name}</span>
		<StateBadge {...sourceState(source.state)} />
		<label class="ml-auto flex items-center gap-2 text-xs text-interactive">
			Enabled
			<Switch
				aria-label="Enable {source.title || source.name}"
				bind:checked={() => source.enabled, (on) => void toggle(on)}
				disabled={busy}
			/>
		</label>
	</div>
	<dl class="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
		<div class="flex gap-1.5">
			<dt class="text-faint">Calls today</dt>
			<dd class={spent ? 'font-semibold text-dnd' : 'text-normal'}>
				{source.budget > 0
					? `${formatCount(source.callsToday)} of ${formatCount(source.budget)}${spent ? ', over budget' : ''}`
					: `${formatCount(source.callsToday)}, no daily budget`}
			</dd>
		</div>
		<div class="flex gap-1.5">
			<dt class="text-faint">Last answered</dt>
			<dd class="text-normal">
				{#if lastOk}
					<time datetime={lastOk.toISOString()} title={formatFull(lastOk)}>{formatAgo(lastOk)}</time>
				{:else}
					Never
				{/if}
			</dd>
		</div>
		<div class="flex gap-1.5">
			<dt class="text-faint">Last failed</dt>
			<dd class="text-normal">
				{#if lastFailed}
					<time datetime={lastFailed.toISOString()} title={formatFull(lastFailed)}>{formatAgo(lastFailed)}</time>
				{:else}
					Never
				{/if}
			</dd>
		</div>
		{#if source.license}
			<div class="flex gap-1.5">
				<dt class="text-faint">License</dt>
				<dd class="min-w-0 break-words text-normal">{source.license}</dd>
			</div>
		{/if}
		{#if source.namespaces.length > 0}
			<div class="flex flex-wrap items-center gap-1.5 sm:col-span-2">
				<dt class="text-faint">Ids</dt>
				{#each source.namespaces as ns (ns)}
					<dd class="rounded bg-tertiary px-1.5 py-0.5 text-[11px] text-normal">{namespaceLabel(ns)}</dd>
				{/each}
			</div>
		{/if}
	</dl>
	{#if source.lastError}
		<p class="rounded bg-dnd/10 px-2 py-1.5 text-xs break-words text-dnd">{source.lastError}</p>
	{/if}
	{#if error}
		<p class="text-sm text-dnd" role="alert">{error}</p>
	{/if}
</li>
