<script lang="ts" module>
	export interface ExternalRefView {
		namespace: string;
		value: string;
		url: string;
		pMatch?: number;
	}
</script>

<script lang="ts">
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { formatPercent } from '#lib/theme/format';
	import { namespaceLabel } from './entity';

	let { refs }: { refs: ExternalRefView[] } = $props();
</script>

{#if refs.length > 0}
	<ul class="flex flex-wrap gap-1.5" aria-label="External ids">
		{#each refs as ref (`${ref.namespace}:${ref.value}`)}
			{@const doubt = ref.pMatch !== undefined && ref.pMatch < 1 ? formatPercent(ref.pMatch) : ''}
			<li>
				{#if ref.url}
					<a
						href={ref.url}
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex max-w-full items-center gap-1 rounded bg-tertiary px-1.5 py-0.5 text-xs text-link hover:underline"
					>
						<span class="font-semibold">{namespaceLabel(ref.namespace)}</span>
						<span class="truncate font-mono text-[11px] text-interactive">{ref.value}</span>
						{#if doubt}
							<span class="text-[11px] text-idle" title="Probability this id belongs here">{doubt}</span>
						{/if}
						<ExternalLink class="size-3 shrink-0" />
					</a>
				{:else}
					<span class="inline-flex max-w-full items-center gap-1 rounded bg-tertiary px-1.5 py-0.5 text-xs">
						<span class="font-semibold text-header">{namespaceLabel(ref.namespace)}</span>
						<span class="truncate font-mono text-[11px] text-interactive">{ref.value}</span>
						{#if doubt}
							<span class="text-[11px] text-idle" title="Probability this id belongs here">{doubt}</span>
						{/if}
					</span>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
