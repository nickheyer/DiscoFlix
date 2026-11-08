<script lang="ts">
	import SmilePlus from '@lucide/svelte/icons/smile-plus';
	import { errorText } from '#lib/api/errors';
	import type { Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { customEmoji } from './emoji';
	import { emojiUrl } from './markdown';
	import EmojiPicker from './EmojiPicker.svelte';
	import { timeline } from './store.svelte';

	let { message }: { message: Message } = $props();

	let picking = $state(false);
	let error = $state('');

	async function toggle(emoji: string, on: boolean): Promise<void> {
		error = '';
		try {
			await timeline.react(message, emoji, on);
		} catch (err) {
			error = errorText(err);
		}
	}

	function pick(emoji: string): void {
		picking = false;
		const existing = message.reactions.find((r) => r.emoji === emoji);
		void toggle(emoji, !(existing?.me ?? false));
	}
</script>

{#if message.reactions.length > 0 || picking || error}
	<div class="relative mt-1 flex flex-wrap items-center gap-1">
		{#each message.reactions as reaction (reaction.emoji)}
			{@const custom = customEmoji(reaction.emoji)}
			<button
				onclick={() => toggle(reaction.emoji, !reaction.me)}
				aria-pressed={reaction.me}
				aria-label="{reaction.count} reacted with {custom?.name ?? reaction.emoji}"
				class="flex h-7 items-center gap-1.5 rounded-lg border px-2 text-sm {reaction.me
					? 'border-blurple bg-blurple/25 text-header'
					: 'border-transparent bg-tertiary/70 text-interactive hover:border-hover'}"
			>
				{#if custom}
					<img src={emojiUrl(custom.id, false)} alt=":{custom.name}:" class="size-4" />
				{:else}
					<span class="text-base leading-none">{reaction.emoji}</span>
				{/if}
				<span class="text-xs font-semibold">{reaction.count}</span>
			</button>
		{/each}
		<button
			onclick={() => (picking = !picking)}
			aria-label="Add reaction"
			aria-expanded={picking}
			class="flex h-7 items-center rounded-lg bg-tertiary/70 px-2 text-interactive opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-normal {picking
				? 'opacity-100'
				: ''}"
		>
			<SmilePlus class="size-4" />
		</button>
		{#if picking}
			<div class="absolute top-8 left-0 z-20">
				<EmojiPicker onpick={pick} onclose={() => (picking = false)} />
			</div>
		{/if}
		{#if error}
			<span class="text-xs text-dnd" role="alert">{error}</span>
		{/if}
	</div>
{/if}
