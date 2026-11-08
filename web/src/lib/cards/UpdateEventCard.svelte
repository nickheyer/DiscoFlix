<script lang="ts">
	import type { UpdateEvent } from '#lib/gen/discoflix/card/v1/system_pb';
	import CardFields from './CardFields.svelte';

	let { card }: { card: UpdateEvent } = $props();
</script>

<CardFields
	fields={[
		{ label: 'Current', value: card.currentVersion, mono: true },
		{ label: 'Available', value: card.availableVersion, mono: true },
		{ label: 'Stage', value: card.stage },
		{ label: 'Detail', value: card.detail, wide: true }
	]}
/>
