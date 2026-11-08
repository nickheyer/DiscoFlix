<script lang="ts">
	import type { SecurityEvent } from '#lib/gen/discoflix/card/v1/system_pb';
	import CardFields from './CardFields.svelte';

	let { card }: { card: SecurityEvent } = $props();
</script>

<CardFields
	fields={[
		{ label: 'User', value: card.userId, mono: true },
		{ label: 'Via', value: card.via },
		{ label: 'Address', value: card.remoteAddr, mono: true },
		{ label: 'User agent', value: card.userAgent, wide: true }
	]}
/>
