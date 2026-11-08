<script lang="ts">
	import Hash from '@lucide/svelte/icons/hash';

	let { name, topic }: { name: string; topic: string } = $props();
</script>

<div class="mx-4 mt-4 mb-2 pt-12">
	<span class="flex size-[68px] items-center justify-center rounded-full bg-hover">
		<Hash class="size-10 text-white" />
	</span>
	<h2 class="mt-2 text-3xl font-bold text-header">Welcome to #{name}</h2>
	<p class="mt-1 text-interactive">This is the start of the #{name} channel.</p>
	{#if topic}
		<p class="mt-1 text-sm text-faint">{topic}</p>
	{/if}
</div>
