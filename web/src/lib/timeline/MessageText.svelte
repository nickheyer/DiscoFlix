<script lang="ts">
	import { linkify } from './linkify';

	let { text }: { text: string } = $props();
</script>

<span class="break-words whitespace-pre-wrap" {@attach linkify(text)}></span>
