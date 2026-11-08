<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { errorText } from '#lib/api/errors';
	import { SpaceKind } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import UserPanel from '#lib/identity/UserPanel.svelte';
	import CategoryHeader from './CategoryHeader.svelte';
	import ChannelLink from './ChannelLink.svelte';
	import { channelsQuery, spacesQuery } from './queries';
	import { readCollapsed, writeCollapsed } from './shell.svelte';
	import { channelTree } from './tree';

	let { spaceId, channelId }: { spaceId: string; channelId: string } = $props();

	const spaces = createQuery(() => spacesQuery());
	const channels = createQuery(() => ({ ...channelsQuery(spaceId), enabled: spaceId !== '' }));
	const space = $derived(spaces.data?.spaces.find((s) => s.id === spaceId));
	const groups = $derived(channelTree(channels.data?.channels ?? []));
	const collapsed = new SvelteSet<string>();

	const kindLabels: Record<SpaceKind, string> = {
		[SpaceKind.UNSPECIFIED]: 'Space',
		[SpaceKind.SYSTEM]: 'System',
		[SpaceKind.GUILD]: 'Discord server',
		[SpaceKind.LIBRARY]: 'Library',
		[SpaceKind.PLUGIN]: 'Plugin',
		[SpaceKind.PROVIDER]: 'AI provider',
		[SpaceKind.SERVER]: 'Media server'
	};

	$effect(() => {
		const ids = groups.flatMap((g) => (g.category ? [g.category.id] : []));
		untrack(() => {
			for (const id of ids) if (readCollapsed(id)) collapsed.add(id);
		});
	});

	function toggle(id: string): void {
		const next = !collapsed.has(id);
		if (next) collapsed.add(id);
		else collapsed.delete(id);
		writeCollapsed(id, next);
	}
</script>

<div class="flex h-full w-60 shrink-0 flex-col bg-sidebar">
	<header
		class="flex h-12 shrink-0 flex-col justify-center px-4 shadow-[0_1px_0_rgba(4,4,5,0.2),0_1.5px_0_rgba(6,6,7,0.05),0_2px_0_rgba(4,4,5,0.05)]"
	>
		{#if space}
			<h2 class="truncate text-[15px] font-semibold text-header">{space.name}</h2>
			<p class="truncate text-[11px] text-faint">{kindLabels[space.kind]}</p>
		{:else if spaceId === ''}
			<h2 class="text-[15px] font-semibold text-header">DiscoFlix</h2>
		{/if}
	</header>
	<nav aria-label="Channels" class="min-h-0 flex-1 overflow-y-auto pb-3 scroll-thin">
		{#if channels.isError}
			<div class="p-4 text-sm">
				<p class="text-dnd">{errorText(channels.error)}</p>
				<button class="mt-1 text-link hover:underline" onclick={() => channels.refetch()}>Retry</button>
			</div>
		{:else if channels.isPending && spaceId !== ''}
			<div class="space-y-2 p-4">
				{#each [70, 50, 60, 40] as width (width)}
					<div class="h-4 animate-pulse rounded bg-hovered" style:width="{width}%"></div>
				{/each}
			</div>
		{:else if channels.isSuccess && groups.length === 0}
			<p class="p-4 text-sm text-faint">This space has no channels</p>
		{/if}
		{#each groups as group (group.category?.id ?? 'loose')}
			{#if group.category}
				<CategoryHeader
					name={group.category.name}
					collapsed={collapsed.has(group.category.id)}
					ontoggle={() => toggle(group.category!.id)}
				/>
			{:else}
				<div class="h-3"></div>
			{/if}
			{#each group.channels as node (node.channel.id)}
				{@const hidden = group.category !== null && collapsed.has(group.category.id)}
				{#if !hidden || node.channel.id === channelId}
					<ChannelLink channel={node.channel} selected={node.channel.id === channelId} />
				{/if}
				{#each node.threads as thread (thread.id)}
					{#if !hidden || thread.id === channelId}
						<ChannelLink channel={thread} selected={thread.id === channelId} nested />
					{/if}
				{/each}
			{/each}
		{/each}
	</nav>
	<UserPanel />
</div>
