<script lang="ts">
	import type { JsonValue } from '@bufbuild/protobuf';

	let { json }: { json: JsonValue } = $props();

	const text = $derived(JSON.stringify(json, null, 2));
</script>

<pre class="max-h-80 overflow-auto rounded bg-tertiary p-2 font-mono text-xs whitespace-pre scroll-thin">{text}</pre>
