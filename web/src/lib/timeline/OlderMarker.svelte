<script lang="ts">
	let { loading, error, onload }: { loading: boolean; error: string | undefined; onload: () => void } = $props();
</script>

<div class="px-4 pt-4 pb-2" aria-busy={loading}>
	{#if error}
		<p class="text-sm text-dnd">{error}</p>
		<button class="mt-1 text-sm text-link hover:underline" onclick={onload}>Retry</button>
	{:else}
		<div class="space-y-5" aria-hidden="true">
			{#each [72, 48, 64] as width (width)}
				<div class="flex gap-4">
					<div class="size-10 shrink-0 animate-pulse rounded-full bg-hovered"></div>
					<div class="flex-1 space-y-2 pt-1">
						<div class="h-3 w-32 animate-pulse rounded bg-hovered"></div>
						<div class="h-3 animate-pulse rounded bg-hovered" style:width="{width}%"></div>
					</div>
				</div>
			{/each}
		</div>
		<button class="sr-only focus:not-sr-only focus:text-link" onclick={onload}>Load older messages</button>
	{/if}
</div>
