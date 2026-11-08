<script lang="ts">
	import { createQueries, createQuery } from '@tanstack/svelte-query';
	import { cardAccent, cardSummary, resolveCard, type Accent } from '#lib/cards/registry';
	import { channelsQuery, spacesQuery } from '#lib/spaces/queries';
	import { formatAgo, formatFull, toDate } from '#lib/theme/format';
	import { timeline } from './store.svelte';

	const spaces = createQuery(() => spacesQuery());
	const items = $derived(timeline.state.activity);
	const spaceIds = $derived([...new Set(items.map((m) => m.spaceId))]);
	const channelLists = createQueries(() => ({ queries: spaceIds.map((id) => channelsQuery(id)) }));

	const channelNames = $derived(
		new Map(channelLists.flatMap((q) => q.data?.channels ?? []).map((c) => [c.id, c.name] as const))
	);
	const spaceNames = $derived(new Map((spaces.data?.spaces ?? []).map((s) => [s.id, s.name] as const)));

	const dots: Record<Accent, string> = {
		info: 'bg-blurple',
		success: 'bg-online',
		warning: 'bg-idle',
		danger: 'bg-dnd',
		neutral: 'bg-faint'
	};

	let now = $state(new Date());
	$effect(() => {
		const timer = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(timer);
	});
</script>

<section aria-label="Recent activity" class="flex flex-col">
	{#if timeline.activityError}
		<p class="mx-2 mb-2 rounded bg-dnd/15 px-2 py-1.5 text-xs text-dnd" role="alert">
			Earlier activity failed to load ({timeline.activityError})
		</p>
	{/if}
	{#if timeline.streamError}
		<p class="mx-2 mb-2 rounded bg-idle/15 px-2 py-1.5 text-xs text-idle" role="alert">
			Live activity is interrupted ({timeline.streamError})
		</p>
	{/if}
	{#if items.length === 0}
		<p class="px-4 py-6 text-center text-sm text-faint">No card activity yet</p>
	{/if}
	<ul>
		{#each items as message (message.seq)}
			{@const card = resolveCard(message.card!)}
			{@const at = toDate(message.editedAt) ?? toDate(message.createdAt)}
			<li>
				<a
					href="/s/{message.spaceId}/c/{message.channelId}"
					class="mx-2 flex gap-2.5 rounded px-2 py-1.5 hover:bg-hovered"
				>
					<span class="mt-1.5 size-2 shrink-0 rounded-full {dots[cardAccent(card)]}"></span>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm text-normal">{cardSummary(card)}</span>
						<span class="block truncate text-xs text-faint">
							#{channelNames.get(message.channelId) ?? message.channelId} in {spaceNames.get(message.spaceId) ??
								message.spaceId}
						</span>
					</span>
					{#if at}
						<time class="shrink-0 pt-0.5 text-[11px] text-faint" datetime={at.toISOString()} title={formatFull(at)}
							>{formatAgo(at, now)}</time
						>
					{/if}
				</a>
			</li>
		{/each}
	</ul>
</section>
