<script lang="ts">
	import { MatchState, type MatchReview } from '#lib/gen/discoflix/card/v1/catalog_pb';
	import { kindLabel, namespaceLabel, sourceLabel } from '#lib/catalog/entity';
	import Meter from '#lib/catalog/Meter.svelte';
	import { entityPath } from '#lib/catalog/routes';
	import { formatFull, formatPercent, toDate } from '#lib/theme/format';
	import { reviewStateLabel } from './catalog-summaries';

	let { card }: { card: MatchReview } = $props();

	const decidedAt = $derived(toDate(card.decidedAt));
	const candidateHref = $derived(
		card.candidateNamespace === 'entity' ? entityPath(card.candidateValue) : card.candidateUrl
	);
	const external = $derived(card.candidateNamespace !== 'entity');
	const tone = $derived(
		card.state === MatchState.PENDING
			? 'text-idle'
			: card.state === MatchState.ACCEPTED
				? 'text-online'
				: 'text-interactive'
	);
</script>

<div class="grid grid-cols-2 gap-2">
	<div class="min-w-0 rounded bg-tertiary p-2">
		<p class="text-[11px] font-bold tracking-wide text-faint uppercase">In the catalog</p>
		<a href={entityPath(card.entityId)} class="block font-semibold break-words text-link hover:underline"
			>{card.entityTitle || 'Untitled'}</a
		>
		<p class="text-xs text-interactive">
			{card.entityYear > 0 ? card.entityYear : 'Year unknown'}, {kindLabel(card.entityKind).toLowerCase()}
		</p>
	</div>
	<div class="min-w-0 rounded bg-tertiary p-2">
		<p class="truncate text-[11px] font-bold tracking-wide text-faint uppercase">
			From {sourceLabel(card.candidateSource)}
		</p>
		{#if candidateHref}
			<a
				href={candidateHref}
				target={external ? '_blank' : undefined}
				rel={external ? 'noopener noreferrer' : undefined}
				class="block font-semibold break-words text-link hover:underline">{card.candidateTitle || 'Untitled'}</a
			>
		{:else}
			<p class="font-semibold break-words text-header">{card.candidateTitle || 'Untitled'}</p>
		{/if}
		<p class="text-xs text-interactive">{card.candidateYear > 0 ? card.candidateYear : 'Year unknown'}</p>
		<p class="truncate font-mono text-[11px] text-faint" title="{card.candidateNamespace} {card.candidateValue}">
			{namespaceLabel(card.candidateNamespace)}
			{card.candidateValue}
		</p>
	</div>
</div>
<div class="mt-2">
	<Meter label="Match probability" ratio={card.probability} text={formatPercent(card.probability)} />
</div>
{#if card.evidence}
	<pre
		class="mt-2 max-h-48 overflow-auto rounded bg-tertiary p-2 font-mono text-xs whitespace-pre-wrap scroll-thin">{card.evidence}</pre>
{/if}
<p class="mt-2 text-sm font-semibold {tone}">
	{reviewStateLabel(card)}
	{#if decidedAt}
		<time class="ml-1 text-xs font-normal text-faint" datetime={decidedAt.toISOString()}>{formatFull(decidedAt)}</time>
	{/if}
</p>
