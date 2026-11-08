<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { Button } from '#lib/ui/button';

	let { value, label = 'Copy' }: { value: string; label?: string } = $props();

	let state = $state<'idle' | 'copied' | 'failed'>('idle');

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			state = 'copied';
		} catch {
			state = 'failed';
		}
		setTimeout(() => (state = 'idle'), 2000);
	}
</script>

<Button variant="secondary" size="sm" onclick={copy} aria-live="polite">
	{#if state === 'copied'}
		<Check class="size-4" /> Copied
	{:else}
		<Copy class="size-4" /> {state === 'failed' ? 'Copy failed, select the text' : label}
	{/if}
</Button>
