<script lang="ts">
	import { create } from '@bufbuild/protobuf';
	import { Code } from '@connectrpc/connect';
	import X from '@lucide/svelte/icons/x';
	import { untrack } from 'svelte';
	import { timelineClient } from '#lib/api/clients';
	import { errorText, hasCode } from '#lib/api/errors';
	import { EventKind, EventSchema, type Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { autosize } from './autosize';
	import { MAX_CONTENT } from './limits';
	import { timeline } from './store.svelte';
	import TypingIndicator from './TypingIndicator.svelte';

	let {
		channelId,
		channelName,
		maxContent = MAX_CONTENT,
		replyTarget,
		oncancelreply,
		onsent
	}: {
		channelId: string;
		channelName: string;
		maxContent?: number;
		replyTarget: Message | null;
		oncancelreply: () => void;
		onsent: () => void;
	} = $props();

	let text = $state(untrack(() => timeline.drafts.get(channelId) ?? ''));
	let sending = $state(false);
	let error = $state('');
	const readOnly = $derived(timeline.readOnly.has(channelId));
	const length = $derived([...text.trim()].length);
	const limit = $derived(maxContent > 0 ? maxContent : MAX_CONTENT);
	const tooLong = $derived(length > limit);
	let lastTyping = 0;

	$effect(() => {
		timeline.drafts.set(channelId, text);
	});

	// Tells the channel the author is typing at most once every five seconds while text changes
	$effect(() => {
		if (text.trim() === '' || readOnly) return;
		const now = Date.now();
		if (now - lastTyping < 5000) return;
		lastTyping = now;
		timelineClient.sendTyping({ channelId }).catch(() => undefined);
	});

	async function send(): Promise<void> {
		const content = text.trim();
		if (content.length === 0 || tooLong || sending || readOnly) return;
		sending = true;
		error = '';
		try {
			const res = await timelineClient.postMessage({ channelId, content, replyTo: replyTarget?.seq ?? 0n });
			if (res.message) {
				timeline.dispatch(
					create(EventSchema, {
						seq: res.message.seq,
						kind: EventKind.MESSAGE_CREATED,
						message: res.message,
						channelId: res.message.channelId,
						spaceId: res.message.spaceId
					})
				);
			}
			text = '';
			lastTyping = 0;
			oncancelreply();
			onsent();
		} catch (err) {
			if (hasCode(err, Code.PermissionDenied)) timeline.readOnly.add(channelId);
			error = errorText(err);
		} finally {
			sending = false;
		}
	}

	function keydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void send();
		} else if (e.key === 'Escape' && replyTarget) {
			e.preventDefault();
			oncancelreply();
		}
	}
</script>

<div class="shrink-0 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
	<TypingIndicator {channelId} />
	{#if error && !readOnly}
		<p role="alert" class="mb-1 text-sm text-dnd">{error}</p>
	{/if}
	{#if replyTarget && !readOnly}
		<div class="flex items-center justify-between rounded-t-lg bg-sidebar px-4 py-2 text-sm text-interactive">
			<span class="truncate">
				Replying to <span class="font-semibold text-header">{replyTarget.author?.displayName ?? 'Unknown user'}</span>
			</span>
			<button aria-label="Cancel reply" onclick={oncancelreply} class="rounded-full p-0.5 hover:text-normal">
				<X class="size-4" />
			</button>
		</div>
	{/if}
	{#if readOnly}
		<div class="rounded-lg bg-field px-4 py-2.5 text-faint" role="status">
			You do not have permission to send messages in this channel
		</div>
	{:else}
		<div class="flex items-end bg-field px-4 {replyTarget ? 'rounded-b-lg' : 'rounded-lg'}">
			<textarea
				bind:value={text}
				{@attach autosize(text)}
				onkeydown={keydown}
				rows="1"
				placeholder="Message #{channelName}"
				aria-label="Message #{channelName}"
				aria-invalid={tooLong}
				class="max-h-[40vh] min-h-11 flex-1 resize-none bg-transparent py-2.5 leading-[22px] text-normal outline-none placeholder:text-faint scroll-thin"
				enterkeyhint="send"></textarea>
			{#if length > limit - 200}
				<span class="py-3 pl-2 text-xs {tooLong ? 'text-dnd' : 'text-faint'}">{limit - length}</span>
			{/if}
		</div>
	{/if}
</div>
