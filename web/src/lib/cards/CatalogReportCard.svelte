<script lang="ts">
	import type { CatalogReport } from '#lib/gen/discoflix/card/v1/catalog_pb';
	import { reportState } from '#lib/catalog/states';
	import StateBadge from '#lib/catalog/StateBadge.svelte';
	import { formatBytes, formatCount, formatDuration, humanize } from '#lib/theme/format';
	import CardFields from './CardFields.svelte';
	import { reportKindLabels } from './catalog-summaries';

	let { card }: { card: CatalogReport } = $props();
</script>

<div class="mb-2 flex flex-wrap items-center gap-2">
	<StateBadge {...reportState(card.state)} />
	<span class="text-xs text-interactive">{reportKindLabels[card.kind] ?? humanize(card.kind)}</span>
</div>
<CardFields
	fields={[
		{ label: 'Name', value: card.name },
		{ label: 'Version', value: card.version, mono: true },
		{ label: 'Rows', value: card.rows > 0n ? formatCount(card.rows) : '' },
		{ label: 'Size', value: card.bytes > 0n ? formatBytes(card.bytes) : '' },
		{ label: 'Took', value: card.durationMs > 0n ? formatDuration(card.durationMs) : '' },
		{ label: 'Detail', value: card.detail, wide: true }
	]}
/>
{#if card.error}
	<pre
		class="mt-2 max-h-48 overflow-auto rounded bg-dnd/10 p-2 font-mono text-xs whitespace-pre-wrap text-dnd scroll-thin"
		role="alert">{card.error}</pre>
{/if}
