<script lang="ts">
	import type { Candidate } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
	import { entitySources, kindLabel, sourceLabel } from './entity';
	import Meter from './Meter.svelte';
	import Poster from './Poster.svelte';
	import { entityPath } from './routes';
	import StateBadge from './StateBadge.svelte';

	let { candidate, scale }: { candidate: Candidate; scale: number } = $props();

	const entity = $derived(candidate.entity);
	const sources = $derived(entity ? entitySources(entity) : []);
</script>

{#if entity}
	<article class="flex gap-3 rounded-lg bg-sidebar p-3 sm:flex-col">
		<a href={entityPath(entity.id)} class="w-20 shrink-0 sm:w-full" tabindex="-1" aria-hidden="true">
			<Poster
				src={entity.poster?.url ?? ''}
				thumbhash={entity.poster?.thumbhash ?? ''}
				variants={entity.poster?.variants ?? []}
				sizes="(min-width: 640px) 220px, 80px"
				alt=""
				class="aspect-[2/3] w-full rounded"
			/>
		</a>
		<div class="min-w-0 flex-1 space-y-1.5">
			<a href={entityPath(entity.id)} class="line-clamp-2 font-semibold break-words text-header hover:underline"
				>{entity.title || 'Untitled'}</a
			>
			<div class="flex flex-wrap items-center gap-1.5 text-xs text-interactive">
				{#if entity.year > 0}
					<span>{entity.year}</span>
				{/if}
				<StateBadge label={kindLabel(entity.kind)} tone="neutral" />
				<StateBadge label={candidate.local ? 'Local' : 'Live'} tone={candidate.local ? 'info' : 'success'} />
			</div>
			<Meter label="Score" ratio={candidate.score / scale} text={candidate.score.toFixed(2)} />
			{#if candidate.explanation}
				<p class="text-xs break-words text-interactive">{candidate.explanation}</p>
			{/if}
			{#if candidate.matchedOn.length > 0}
				<ul class="flex flex-wrap gap-1" aria-label="Matched on">
					{#each candidate.matchedOn as match (match)}
						<li class="rounded-full bg-blurple/20 px-2 py-0.5 text-[11px] font-semibold text-blurple">{match}</li>
					{/each}
				</ul>
			{/if}
			{#if sources.length > 0}
				<p class="text-[11px] text-faint">From {sources.map(sourceLabel).join(', ')}</p>
			{/if}
		</div>
	</article>
{/if}
