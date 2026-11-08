<script lang="ts">
	import type { EntityCard } from '#lib/gen/discoflix/card/v1/catalog_pb';
	import ExternalLinks from '#lib/catalog/ExternalLinks.svelte';
	import { kindLabel, sourceLabel } from '#lib/catalog/entity';
	import Meter from '#lib/catalog/Meter.svelte';
	import Poster from '#lib/catalog/Poster.svelte';
	import { entityPath } from '#lib/catalog/routes';
	import StateBadge from '#lib/catalog/StateBadge.svelte';
	import { formatPercent, plural } from '#lib/theme/format';

	let { card }: { card: EntityCard } = $props();

	const CLIPPED = 180;
	let expanded = $state(false);
	const href = $derived(entityPath(card.entityId));
</script>

<div class="flex gap-3">
	<a {href} class="w-20 shrink-0 sm:w-24" tabindex="-1" aria-hidden="true">
		<Poster src={card.posterUrl} thumbhash={card.thumbhash} alt="" class="aspect-[2/3] w-full rounded" />
	</a>
	<div class="min-w-0 flex-1 space-y-1.5">
		<div>
			<a {href} class="font-semibold break-words text-link hover:underline">{card.title || 'Untitled'}</a>
			<div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-interactive">
				{#if card.year > 0}
					<span>{card.year}</span>
				{/if}
				<StateBadge label={kindLabel(card.kind)} tone="neutral" />
				{#if card.originalTitle}
					<span class="italic">{card.originalTitle}</span>
				{/if}
			</div>
		</div>
		{#if card.overview}
			<p class="break-words {expanded ? '' : 'line-clamp-3'}">{card.overview}</p>
			{#if card.overview.length > CLIPPED}
				<button
					class="text-xs text-link hover:underline"
					aria-expanded={expanded}
					onclick={() => (expanded = !expanded)}
				>
					{expanded ? 'Show less' : 'Show more'}
				</button>
			{/if}
		{/if}
		<Meter label="Confidence" ratio={card.confidence} text={formatPercent(card.confidence)} />
		{#if card.explanation}
			<p class="text-xs break-words text-interactive">{card.explanation}</p>
		{/if}
		<ExternalLinks refs={card.externalIds} />
		<p class="text-[11px] text-faint">
			{plural(card.fields, 'field')} with provenance{card.sources.length > 0
				? ` from ${card.sources.map(sourceLabel).join(', ')}`
				: ''}
		</p>
		<a {href} class="inline-block text-xs font-semibold text-link hover:underline">Open entity page</a>
	</div>
</div>
