<script lang="ts">
	import { create } from '@bufbuild/protobuf';
	import { timestampNow } from '@bufbuild/protobuf/wkt';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import { onDestroy, tick, untrack } from 'svelte';
	import { Virtualizer, type VirtualizerHandle } from 'virtua/svelte';
	import { timelineClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { EventKind, EventSchema, type Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { session } from '#lib/identity/session.svelte';
	import { pageVisibility } from '#lib/theme/viewport.svelte';
	import * as AlertDialog from '#lib/ui/alert-dialog';
	import ChannelStart from './ChannelStart.svelte';
	import DaySeparator from './DaySeparator.svelte';
	import MessageRow from './MessageRow.svelte';
	import OlderMarker from './OlderMarker.svelte';
	import { buildRows, type Row } from './rows';
	import { timeline } from './store.svelte';

	let {
		channelId,
		channelName,
		topic,
		onreply
	}: { channelId: string; channelName: string; topic: string; onreply: (message: Message) => void } = $props();

	const entry = $derived(timeline.state.messages.get(channelId));
	const items = $derived(entry?.items ?? []);
	const rows = $derived(buildRows(items, entry?.hasOlder ?? true));
	const counter = $derived(timeline.state.channels.get(channelId));
	const loadingOlder = $derived(timeline.loadingOlder.get(channelId) ?? false);
	const error = $derived(timeline.channelErrors.get(channelId));
	const newest = $derived(items[items.length - 1]);
	const selfId = $derived(session.user?.id ?? '');

	let scroller = $state<HTMLDivElement>();
	let list = $state<VirtualizerHandle>();
	let spacer = $state(0);
	let shift = $state(false);
	let atBottom = $state(true);
	let editingSeq = $state<bigint | null>(null);
	let pendingDelete = $state<Message | null>(null);
	let deleteError = $state('');
	let readError = $state('');
	let pinned = true;

	const reading = $derived(atBottom && pageVisibility.visible && newest !== undefined);

	function measure(): void {
		const el = scroller;
		if (!el) return;
		atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
		if (el.scrollTop < 400) void older();
	}

	async function older(): Promise<void> {
		if (!entry?.hasOlder || loadingOlder || items.length === 0) return;
		shift = true;
		await timeline.loadOlder(channelId);
		await tick();
		shift = false;
	}

	// Scrolls to the newest message, used after sending and by the jump button
	export function jumpToLatest(): void {
		if (rows.length > 0) list?.scrollToIndex(rows.length - 1, { align: 'end' });
		atBottom = true;
	}

	function jumpTo(seq: bigint): void {
		const index = rows.findIndex((r) => r.kind === 'message' && r.message.seq === seq);
		if (index >= 0) list?.scrollToIndex(index, { align: 'center', smooth: true });
	}

	function find(seq: bigint): Message | undefined {
		return items.find((m) => m.seq === seq);
	}

	$effect.pre(() => {
		void rows;
		pinned = untrack(() => atBottom);
	});

	$effect(() => {
		void rows;
		const ready = list !== undefined;
		untrack(() => {
			if (ready && pinned && !shift) jumpToLatest();
			void tick().then(measure);
		});
	});

	$effect(() => {
		timeline.readingChannelId = reading ? channelId : null;
		return () => {
			if (timeline.readingChannelId === channelId) timeline.readingChannelId = null;
		};
	});

	let pendingRead: bigint | null = null;

	function sendRead(seq: bigint): void {
		pendingRead = null;
		timeline.markRead(channelId, seq).then(
			() => (readError = ''),
			(err) => (readError = errorText(err))
		);
	}

	$effect(() => {
		pendingRead = null;
		if (!reading || !newest) return;
		const seq = newest.seq;
		if (counter?.known && counter.lastReadSeq >= seq && counter.unread === 0n) return;
		pendingRead = seq;
		const timer = setTimeout(() => sendRead(seq), 600);
		return () => clearTimeout(timer);
	});

	onDestroy(() => {
		if (pendingRead !== null) sendRead(pendingRead);
	});

	async function confirmDelete(): Promise<void> {
		const message = pendingDelete;
		if (!message) return;
		deleteError = '';
		try {
			await timelineClient.deleteMessage({ seq: message.seq });
			timeline.dispatch(
				create(EventSchema, {
					kind: EventKind.MESSAGE_DELETED,
					message: { ...message, deletedAt: timestampNow() },
					channelId: message.channelId,
					spaceId: message.spaceId
				})
			);
			pendingDelete = null;
		} catch (err) {
			deleteError = errorText(err);
		}
	}
</script>

<div class="relative h-full">
	<div
		bind:this={scroller}
		onscroll={measure}
		class="flex h-full flex-col overflow-x-hidden overflow-y-auto overscroll-contain pb-4 scroll-thin"
		role="log"
		aria-label="Messages in {channelName}"
		aria-busy={loadingOlder}
	>
		<div class="grow" bind:clientHeight={spacer}></div>
		<div class="shrink-0">
			<Virtualizer
				bind:this={list}
				data={rows}
				getKey={(row: Row) => row.key}
				scrollRef={scroller}
				startMargin={spacer}
				{shift}
			>
				{#snippet children(row: Row)}
					{#if row.kind === 'message'}
						{@const message = row.message}
						<MessageRow
							{message}
							date={row.date}
							grouped={row.grouped}
							own={message.author?.id === selfId}
							canDelete={message.author?.id === selfId || session.isAdmin}
							editing={editingSeq === message.seq}
							replied={message.replyTo !== 0n ? find(message.replyTo) : undefined}
							onreply={() => onreply(message)}
							onedit={() => (editingSeq = message.seq)}
							ondelete={() => {
								deleteError = '';
								pendingDelete = message;
							}}
							oneditdone={() => (editingSeq = null)}
							onjump={jumpTo}
						/>
					{:else if row.kind === 'day'}
						<DaySeparator date={row.date} />
					{:else if row.kind === 'start'}
						<ChannelStart name={channelName} {topic} />
					{:else}
						<OlderMarker
							loading={loadingOlder}
							error={items.length > 0 || !error ? undefined : error}
							onload={() => (items.length > 0 ? older() : timeline.loadLatest(channelId))}
						/>
					{/if}
				{/snippet}
			</Virtualizer>
		</div>
	</div>
	{#if (error && items.length > 0) || readError}
		<p role="alert" class="absolute inset-x-4 top-2 rounded bg-dnd/90 px-3 py-1.5 text-sm text-white shadow">
			{error && items.length > 0 ? error : `Marking this channel read failed (${readError})`}
		</p>
	{/if}
	{#if !atBottom}
		<button
			onclick={jumpToLatest}
			class="absolute right-4 bottom-3 flex items-center gap-1 rounded-full bg-blurple px-3 py-1.5 text-sm font-semibold text-white shadow-lg hover:bg-blurple/90"
		>
			<ArrowDown class="size-4" />
			Jump to present
		</button>
	{/if}
</div>

<AlertDialog.Root
	open={pendingDelete !== null}
	onOpenChange={(open) => {
		if (!open) pendingDelete = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete message</AlertDialog.Title>
			<AlertDialog.Description>Are you sure you want to delete this message?</AlertDialog.Description>
		</AlertDialog.Header>
		{#if pendingDelete}
			<blockquote class="max-h-40 overflow-hidden rounded bg-sidebar p-3 text-sm break-words whitespace-pre-wrap">
				{pendingDelete.content || 'A card message'}
			</blockquote>
		{/if}
		{#if deleteError}
			<p class="text-sm text-dnd" role="alert">{deleteError}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action class="bg-dnd text-white hover:bg-dnd/90" onclick={confirmDelete}>Delete</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
