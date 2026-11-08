<script lang="ts">
	import { useMentions } from './mentions.svelte';
	import { renderMarkdown } from './render';

	let { text }: { text: string } = $props();

	const mentions = useMentions();
</script>

<span class="break-words" {@attach renderMarkdown(text, mentions())}></span>
