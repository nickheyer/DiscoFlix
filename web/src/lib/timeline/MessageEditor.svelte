<script lang="ts">
	import { create } from '@bufbuild/protobuf';
	import { untrack } from 'svelte';
	import { timelineClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { EventKind, EventSchema, type Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { autosize } from './autosize';
	import { MAX_CONTENT } from './limits';
	import { timeline } from './store.svelte';

	let { message, ondone }: { message: Message; ondone: () => void } = $props();

	let text = $state(untrack(() => message.content));
	let saving = $state(false);
	let error = $state('');

	async function save(): Promise<void> {
		const content = text.trim();
		if (content === message.content) {
			ondone();
			return;
		}
		if (content.length === 0 || content.length > MAX_CONTENT) {
			error = content.length === 0 ? 'A message cannot be empty' : `Messages are limited to ${MAX_CONTENT} characters`;
			return;
		}
		saving = true;
		error = '';
		try {
			const res = await timelineClient.editMessage({ seq: message.seq, content });
			if (res.message) {
				timeline.dispatch(
					create(EventSchema, {
						kind: EventKind.MESSAGE_EDITED,
						message: res.message,
						channelId: res.message.channelId,
						spaceId: res.message.spaceId
					})
				);
			}
			ondone();
		} catch (err) {
			error = errorText(err);
		} finally {
			saving = false;
		}
	}

	function focusEnd(node: HTMLTextAreaElement): void {
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}

	function keydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			ondone();
		} else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void save();
		}
	}
</script>

<div class="py-1">
	<textarea
		bind:value={text}
		{@attach autosize(text)}
		{@attach focusEnd}
		onkeydown={keydown}
		disabled={saving}
		rows="1"
		aria-label="Edit message"
		class="max-h-[50vh] w-full resize-none rounded-lg bg-field px-4 py-2.5 text-normal outline-none scroll-thin"
	></textarea>
	<p class="text-xs text-interactive">
		escape to <button class="text-link hover:underline" onclick={ondone}>cancel</button>, enter to
		<button class="text-link hover:underline" onclick={save}>save</button>
	</p>
	{#if error}
		<p class="text-xs text-dnd" role="alert">{error}</p>
	{/if}
</div>
