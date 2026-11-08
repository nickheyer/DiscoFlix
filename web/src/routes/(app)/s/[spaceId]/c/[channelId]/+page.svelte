<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { page } from '$app/state';
	import { ChannelKind, type Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { channelsQuery, membersQuery, spacesQuery } from '#lib/spaces/queries';
	import { rememberChannel } from '#lib/spaces/shell.svelte';
	import ChannelHeader from '#lib/timeline/ChannelHeader.svelte';
	import Composer from '#lib/timeline/Composer.svelte';
	import type { MentionResolver } from '#lib/timeline/markdown';
	import { provideMentions } from '#lib/timeline/mentions.svelte';
	import { timeline } from '#lib/timeline/store.svelte';
	import Timeline from '#lib/timeline/Timeline.svelte';

	const spaceId = $derived(page.params.spaceId ?? '');
	const channelId = $derived(page.params.channelId ?? '');
	const spaces = createQuery(() => spacesQuery());
	const channels = createQuery(() => channelsQuery(spaceId));
	const members = createQuery(() => membersQuery(spaceId));
	const space = $derived(spaces.data?.spaces.find((s) => s.id === spaceId));
	const channel = $derived(channels.data?.channels.find((c) => c.id === channelId));
	const parent = $derived(
		channel?.parentId ? channels.data?.channels.find((c) => c.id === channel.parentId) : undefined
	);
	const missing = $derived(channels.isSuccess && !channel);
	const name = $derived(channel?.name ?? '');
	const canThread = $derived(channel !== undefined && channel.kind === ChannelKind.TEXT);

	// Maps Discord ids in message text onto the names this space knows
	const resolver = $derived.by<MentionResolver>(() => {
		const users = new Map(
			(members.data?.members ?? [])
				.filter((m) => m.externalId !== '')
				.map((m) => [m.externalId, { name: m.nickname || m.user?.displayName || 'member' }] as const)
		);
		const roles = new Map(
			(members.data?.roles ?? []).map((r) => [r.id, { name: r.name, color: r.color || undefined }] as const)
		);
		const chans = new Map(
			(channels.data?.channels ?? [])
				.filter((c) => c.externalId !== '')
				.map((c) => [c.externalId, { name: c.name, href: `/s/${c.spaceId}/c/${c.id}` }] as const)
		);
		return { user: (id) => users.get(id), channel: (id) => chans.get(id), role: (id) => roles.get(id) };
	});
	provideMentions(() => resolver);

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
		<ChannelHeader
			{name}
			topic={channel?.topic ?? ''}
			mirrored={(channel?.externalId ?? '') !== '' && space?.externalId !== ''}
			parent={parent ? { name: parent.name, href: `/s/${spaceId}/c/${parent.id}` } : null}
		/>
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
					{spaceId}
					{channelId}
					channelName={name}
					topic={channel?.topic ?? ''}
					{canThread}
					onreply={(message) => (replyTarget = message)}
				/>
			</div>
			<Composer
				{channelId}
				channelName={name}
				maxContent={channel?.maxContent ?? 0}
				{replyTarget}
				oncancelreply={() => (replyTarget = null)}
				onsent={() => list?.jumpToLatest()}
			/>
		{/if}
	</main>
{/key}
