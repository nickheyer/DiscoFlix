<script lang="ts">
	import Hash from '@lucide/svelte/icons/hash';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import Volume2 from '@lucide/svelte/icons/volume-2';
	import { ChannelKind, type Channel } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { timeline } from '#lib/timeline/store.svelte';

	let { channel, selected, nested = false }: { channel: Channel; selected: boolean; nested?: boolean } = $props();

	const unread = $derived(timeline.state.channels.get(channel.id)?.unread ?? channel.unread);
	const Icon = $derived(
		channel.kind === ChannelKind.VOICE ? Volume2 : channel.kind === ChannelKind.THREAD ? MessagesSquare : Hash
	);
</script>

<a
	href="/s/{channel.spaceId}/c/{channel.id}"
	aria-current={selected ? 'page' : undefined}
	title={channel.topic || channel.name}
	class="group relative mx-2 flex items-center gap-1.5 rounded px-2 py-1.5 text-[15px] leading-5
	{nested ? 'ml-7' : ''}
	{selected
		? 'bg-selected text-header'
		: unread > 0n
			? 'font-semibold text-header hover:bg-hovered'
			: 'text-faint hover:bg-hovered hover:text-normal'}"
>
	{#if unread > 0n && !selected}
		<span class="absolute top-1/2 -left-2 h-2 w-1 -translate-y-1/2 rounded-r bg-header"></span>
	{/if}
	<Icon class="size-5 shrink-0 {selected || unread > 0n ? 'text-header' : 'text-faint'}" />
	<span class="truncate">{channel.name}</span>
	{#if unread > 0n && !selected}
		<span class="ml-auto rounded-full bg-dnd px-1.5 text-xs leading-4 font-bold text-white">
			{unread > 99n ? '99+' : unread.toString()}
		</span>
	{/if}
</a>
