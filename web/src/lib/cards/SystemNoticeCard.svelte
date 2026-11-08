<script lang="ts">
	import type { SystemNotice } from '#lib/gen/discoflix/card/v1/system_pb';

	let { card }: { card: SystemNotice } = $props();
</script>

{#if card.body}
	<p class="break-words whitespace-pre-wrap">{card.body}</p>
{/if}
