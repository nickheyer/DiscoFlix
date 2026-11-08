<script lang="ts">
	import type { Snippet } from 'svelte';
	import { session } from '#lib/identity/session.svelte';

	let { children }: { children: Snippet } = $props();
</script>

{#if session.isAdmin}
	{@render children()}
{:else}
	<div class="rounded-lg bg-sidebar p-6 text-center">
		<h2 class="font-semibold text-header">Administrator access required</h2>
		<p class="mt-1 text-sm text-interactive">Only server administrators can open this page.</p>
	</div>
{/if}
