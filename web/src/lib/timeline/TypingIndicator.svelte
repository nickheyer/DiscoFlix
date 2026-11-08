<script lang="ts">
	import { timeline } from './store.svelte';

	let { channelId }: { channelId: string } = $props();

	const typing = $derived(timeline.typingIn(channelId));
	const text = $derived.by(() => {
		const names = typing.map((t) => t.name);
		if (names.length === 0) return '';
		if (names.length === 1) return `${names[0]} is typing`;
		if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
		if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are typing`;
		return 'Several people are typing';
	});
</script>

<div class="flex h-5 items-center gap-1.5 px-4 text-xs text-normal" aria-live="polite">
	{#if text}
		<span class="flex gap-0.5">
			{#each [0, 1, 2] as i (i)}
				<span class="size-1.5 animate-bounce rounded-full bg-interactive" style:animation-delay="{i * 120}ms"></span>
			{/each}
		</span>
		<span><strong class="font-semibold">{text}</strong></span>
	{/if}
</div>
