<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import ChannelSidebar from '#lib/spaces/ChannelSidebar.svelte';
	import RightRail from '#lib/spaces/RightRail.svelte';
	import { shell } from '#lib/spaces/shell.svelte';
	import SpaceRail from '#lib/spaces/SpaceRail.svelte';
	import { mobile } from '#lib/theme/viewport.svelte';
	import { timeline } from '#lib/timeline/store.svelte';
	import * as Sheet from '#lib/ui/sheet';

	let { children } = $props();

	const spaceId = $derived(page.params.spaceId ?? '');
	const channelId = $derived(page.params.channelId ?? '');

	$effect(() => {
		if (spaceId === '') return;
		return timeline.openSpace(spaceId);
	});

	afterNavigate(() => {
		shell.navOpen = false;
		shell.rightOpen = false;
	});
</script>

{#snippet navigation()}
	<div class="flex h-full">
		<SpaceRail selectedId={spaceId} />
		<ChannelSidebar {spaceId} {channelId} />
	</div>
{/snippet}

<div class="fixed inset-x-0 top-[var(--app-offset)] flex app-height overflow-hidden bg-chat">
	{#if mobile.current}
		<Sheet.Root bind:open={shell.navOpen}>
			<Sheet.Content
				side="left"
				showCloseButton={false}
				class="w-auto max-w-none gap-0 border-0 bg-rail p-0 sm:max-w-none"
			>
				<Sheet.Title class="sr-only">Navigation</Sheet.Title>
				{@render navigation()}
			</Sheet.Content>
		</Sheet.Root>
		<Sheet.Root bind:open={shell.rightOpen}>
			<Sheet.Content side="right" showCloseButton={false} class="w-auto max-w-none gap-0 border-0 p-0 sm:max-w-none">
				<Sheet.Title class="sr-only">Activity and members</Sheet.Title>
				<RightRail {spaceId} />
			</Sheet.Content>
		</Sheet.Root>
	{:else}
		{@render navigation()}
	{/if}
	<div class="flex min-w-0 flex-1">
		{@render children()}
	</div>
	{#if !mobile.current && shell.rightDocked}
		<RightRail {spaceId} />
	{/if}
</div>
