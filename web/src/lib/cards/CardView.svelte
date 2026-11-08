<script lang="ts">
	import type { Any } from '@bufbuild/protobuf/wkt';
	import CardFrame from './CardFrame.svelte';
	import GenericCard from './GenericCard.svelte';
	import { cardAccent, cardSummary, resolveCard } from './registry';

	let { card }: { card: Any } = $props();

	const resolved = $derived(resolveCard(card));
</script>

<CardFrame
	accent={cardAccent(resolved)}
	title={cardSummary(resolved)}
	typeLabel={resolved.kind === 'known' ? resolved.typeName : resolved.typeUrl}
>
	{#if resolved.kind === 'known'}
		{@const Renderer = resolved.renderer.component}
		<Renderer card={resolved.message} />
	{:else}
		<GenericCard json={resolved.json} />
	{/if}
</CardFrame>
