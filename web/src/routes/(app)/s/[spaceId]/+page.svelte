<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { errorText } from '#lib/api/errors';
	import { channelsQuery } from '#lib/spaces/queries';
	import { lastChannel, shell } from '#lib/spaces/shell.svelte';
	import { defaultChannel } from '#lib/spaces/tree';
	import { mobile } from '#lib/theme/viewport.svelte';
	import { Button } from '#lib/ui/button';

	const spaceId = $derived(page.params.spaceId ?? '');
	const channels = createQuery(() => channelsQuery(spaceId));
	const target = $derived(defaultChannel(channels.data?.channels ?? [], lastChannel(spaceId)));

	$effect(() => {
		if (target) void goto(`/s/${spaceId}/c/${target.id}`, { replaceState: true });
	});
</script>

<main class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
	{#if channels.isError}
		<p class="text-dnd" role="alert">{errorText(channels.error)}</p>
		<Button onclick={() => channels.refetch()}>Retry</Button>
	{:else if channels.isSuccess && !target}
		<h1 class="text-xl font-semibold text-header">No channels here</h1>
		<p class="text-sm text-interactive">This space has no channels you can open.</p>
		{#if mobile.current}
			<Button variant="secondary" onclick={() => (shell.navOpen = true)}>Open navigation</Button>
		{/if}
	{:else}
		<p class="text-sm text-interactive" role="status">Opening channel</p>
	{/if}
</main>
