<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { page } from '$app/state';
	import type { Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { channelsQuery } from '#lib/spaces/queries';
	import { rememberChannel } from '#lib/spaces/shell.svelte';
	import ChannelHeader from '#lib/timeline/ChannelHeader.svelte';
	import Composer from '#lib/timeline/Composer.svelte';
	import { timeline } from '#lib/timeline/store.svelte';
	import Timeline from '#lib/timeline/Timeline.svelte';

	const spaceId = $derived(page.params.spaceId ?? '');
	const channelId = $derived(page.params.channelId ?? '');
	const channels = createQuery(() => channelsQuery(spaceId));
	const channel = $derived(channels.data?.channels.find((c) => c.id === channelId));
	const missing = $derived(channels.isSuccess && !channel);
	const name = $derived(channel?.name ?? '');

	let replyTarget = $state<Message | null>(null);
	let list = $state<Timeline>();

	$effect(() => {
		const close = timeline.open(spaceId, channelId);
		rememberChannel(spaceId, channelId);
		replyTarget = null;
		return close;
	});
</script>

<svelte:head>
	<title>#{name || 'channel'}</title>
</svelte:head>

{#key channelId}
	<main class="flex min-w-0 flex-1 flex-col bg-chat">
		<ChannelHeader {name} topic={channel?.topic ?? ''} />
		{#if missing}
			<div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
				<h2 class="text-xl font-semibold text-header">Channel not found</h2>
				<p class="text-sm text-interactive">It may have been removed or you no longer have access.</p>
				<a href="/s/{spaceId}" class="text-link hover:underline">Back to the space</a>
			</div>
		{:else}
			<div class="min-h-0 flex-1">
				<Timeline
					bind:this={list}
					{channelId}
					channelName={name}
					topic={channel?.topic ?? ''}
					onreply={(message) => (replyTarget = message)}
				/>
			</div>
			<Composer
				{channelId}
				channelName={name}
				{replyTarget}
				oncancelreply={() => (replyTarget = null)}
				onsent={() => list?.jumpToLatest()}
			/>
		{/if}
	</main>
{/key}
