<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import type { SourceOutcome } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
	import { formatDuration, plural } from '#lib/theme/format';
	import { sourceLabel } from './entity';
	import { outcomeState } from './states';
	import StateBadge from './StateBadge.svelte';

	let { sources }: { sources: SourceOutcome[] } = $props();

	const answered = $derived(sources.filter((s) => s.state === 'answered').length);
	const down = $derived(sources.filter((s) => outcomeState(s.state).tone === 'danger').length);
</script>

{#if sources.length > 0}
	<details class="group rounded-lg bg-sidebar">
		<summary
			class="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-sm select-none [&::-webkit-details-marker]:hidden"
		>
			<ChevronRight class="size-4 shrink-0 text-faint transition-transform group-open:rotate-90" />
			<span class="font-semibold text-header">Sources</span>
			<span class="text-interactive">{answered} of {sources.length} answered</span>
			{#if down > 0}
				<span class="text-dnd">{down} could not answer</span>
			{/if}
		</summary>
		<ul class="divide-y divide-divider border-t border-divider">
			{#each sources as s (s.source)}
				<li
					class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:grid-cols-[9rem_10rem_6rem_5rem_minmax(0,1fr)]"
				>
					<span class="truncate font-medium text-header">{sourceLabel(s.source)}</span>
					<span class="justify-self-end sm:justify-self-start"><StateBadge {...outcomeState(s.state)} /></span>
					<span class="text-xs text-interactive">{plural(s.results, 'result')}</span>
					<span class="text-xs text-interactive tabular-nums">{formatDuration(s.durationMs)}</span>
					{#if s.detail}
						<span class="col-span-full text-xs break-words text-faint sm:col-span-1">{s.detail}</span>
					{/if}
				</li>
			{/each}
		</ul>
	</details>
{/if}
