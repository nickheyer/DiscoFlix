<script lang="ts">
	import type { BootReport } from '#lib/gen/discoflix/card/v1/system_pb';
	import CardFields from './CardFields.svelte';

	let { card }: { card: BootReport } = $props();
</script>

<CardFields
	fields={[
		{ label: 'Commit', value: card.commit.slice(0, 12), mono: true },
		{ label: 'Go', value: card.goVersion },
		{ label: 'Platform', value: card.os && card.arch ? `${card.os}/${card.arch}` : card.os || card.arch },
		{ label: 'Mode', value: card.mode },
		{ label: 'Migrations applied', value: String(card.migrationsApplied) },
		{ label: 'Data directory', value: card.dataDir, mono: true, wide: true }
	]}
/>
