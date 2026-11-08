<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, description = '', children }: { title: string; description?: string; children: Snippet } = $props();
</script>

<section class="border-b border-divider py-6 first:pt-0 last:border-b-0">
	<h2 class="text-xs font-bold tracking-wide text-interactive uppercase">{title}</h2>
	{#if description}
		<p class="mt-1 text-sm text-faint">{description}</p>
	{/if}
	<div class="mt-4">{@render children()}</div>
</section>
