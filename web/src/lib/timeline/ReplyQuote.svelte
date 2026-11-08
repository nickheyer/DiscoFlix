<script lang="ts">
	import { createQueryOptions } from '@connectrpc/connect-query-core';
	import CornerUpLeft from '@lucide/svelte/icons/corner-up-left';
	import { createQuery } from '@tanstack/svelte-query';
	import { errorText } from '#lib/api/errors';
	import { transport } from '#lib/api/transport';
	import { TimelineService, type Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import UserAvatar from '#lib/identity/UserAvatar.svelte';

	let {
		channelId,
		replyTo,
		loaded,
		onjump
	}: { channelId: string; replyTo: bigint; loaded: Message | undefined; onjump: (seq: bigint) => void } = $props();

	const lookup = createQuery(() => ({
		...createQueryOptions(
			TimelineService.method.listMessages,
			{ channelId, beforeSeq: replyTo + 1n, limit: 1 },
			{ transport }
		),
		enabled: loaded === undefined,
		staleTime: Number.POSITIVE_INFINITY
	}));

	const original = $derived(loaded ?? lookup.data?.messages.find((m) => m.seq === replyTo));
	const gone = $derived(original?.deletedAt !== undefined || (lookup.isSuccess && !original));
	const preview = $derived(original?.content || (original?.card ? 'Sent a card' : ''));
</script>

<div class="flex min-w-0 items-center gap-1 pl-[72px] text-sm leading-5 text-interactive">
	<CornerUpLeft class="absolute left-9 size-4 -scale-x-100 text-faint" />
	{#if original && !gone}
		<UserAvatar
			id={original.author?.id ?? ''}
			name={original.author?.displayName ?? '?'}
			src={original.author?.avatarUrl}
			accent={original.author?.accentColor}
			size={16}
		/>
		<button class="flex min-w-0 items-center gap-1 text-left hover:text-header" onclick={() => onjump(replyTo)}>
			<span class="shrink-0 font-medium text-header">{original.author?.displayName ?? 'Unknown user'}</span>
			<span class="truncate">{preview}</span>
		</button>
	{:else if gone}
		<span class="italic">Original message was deleted</span>
	{:else if lookup.isError}
		<span class="text-dnd">{errorText(lookup.error)}</span>
	{:else}
		<span class="italic">Loading reply</span>
	{/if}
</div>
