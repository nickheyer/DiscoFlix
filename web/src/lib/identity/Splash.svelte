<script lang="ts">
	import Mark from '#lib/theme/Mark.svelte';
	import { Button } from '#lib/ui/button';
	import { session } from './session.svelte';
</script>

<main class="flex app-height flex-col items-center justify-center gap-4 bg-chat p-6 text-center">
	<Mark size={72} class={session.status === 'error' ? '' : 'animate-pulse'} />
	{#if session.status === 'error'}
		<h1 class="text-xl font-semibold text-header">DiscoFlix is unreachable</h1>
		<p class="max-w-sm text-sm text-interactive" role="alert">{session.error}</p>
		<Button onclick={() => session.load()}>Try again</Button>
	{:else}
		<p class="text-sm text-interactive" role="status">Connecting to DiscoFlix</p>
	{/if}
</main>
