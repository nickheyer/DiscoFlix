<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { errorText } from '#lib/api/errors';
	import { spacesQuery } from '#lib/spaces/queries';
	import { lastSpace } from '#lib/spaces/shell.svelte';
	import { shell } from '#lib/spaces/shell.svelte';
	import { mobile } from '#lib/theme/viewport.svelte';
	import Mark from '#lib/theme/Mark.svelte';
	import { Button } from '#lib/ui/button';

	const spaces = createQuery(() => spacesQuery());
	const target = $derived.by(() => {
		const list = [...(spaces.data?.spaces ?? [])].sort((a, b) => a.position - b.position);
		return list.find((s) => s.id === lastSpace()) ?? list[0];
	});

	$effect(() => {
		if (target) void goto(`/s/${target.id}`, { replaceState: true });
	});
</script>

<main class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
	<Mark size={64} />
	{#if spaces.isError}
		<p class="text-dnd" role="alert">{errorText(spaces.error)}</p>
		<Button onclick={() => spaces.refetch()}>Retry</Button>
	{:else if spaces.isSuccess && !target}
		<h1 class="text-xl font-semibold text-header">No spaces yet</h1>
		<p class="max-w-sm text-sm text-interactive">
			You are not a member of any space. An administrator can add you to one.
		</p>
		{#if mobile.current}
			<Button variant="secondary" onclick={() => (shell.navOpen = true)}>Open navigation</Button>
		{/if}
	{:else}
		<p class="text-sm text-interactive" role="status">Opening your spaces</p>
	{/if}
</main>
