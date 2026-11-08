<script lang="ts">
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Reply from '@lucide/svelte/icons/reply';
	import SmilePlus from '@lucide/svelte/icons/smile-plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import CardView from '#lib/cards/CardView.svelte';
	import type { Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import UserAvatar from '#lib/identity/UserAvatar.svelte';
	import { formatFull, formatStamp, formatTime, toDate } from '#lib/theme/format';
	import * as Tooltip from '#lib/ui/tooltip';
	import Attachments from './Attachments.svelte';
	import EmojiPicker from './EmojiPicker.svelte';
	import MessageEditor from './MessageEditor.svelte';
	import MessageText from './MessageText.svelte';
	import Reactions from './Reactions.svelte';
	import ReplyQuote from './ReplyQuote.svelte';
	import { timeline } from './store.svelte';

	let {
		message,
		date,
		grouped,
		own,
		canDelete,
		canThread,
		editing,
		replied,
		onreply,
		onedit,
		ondelete,
		onthread,
		oneditdone,
		onjump
	}: {
		message: Message;
		date: Date;
		grouped: boolean;
		own: boolean;
		canDelete: boolean;
		canThread: boolean;
		editing: boolean;
		replied: Message | undefined;
		onreply: () => void;
		onedit: () => void;
		ondelete: () => void;
		onthread: () => void;
		oneditdone: () => void;
		onjump: (seq: bigint) => void;
	} = $props();

	const author = $derived(message.author);
	const name = $derived(author?.displayName || 'Unknown user');
	const automated = $derived(author !== undefined && author.kind !== '' && author.kind !== 'person');
	const edited = $derived(toDate(message.editedAt));
	const deleted = $derived(message.deletedAt !== undefined);
	const mirrored = $derived(message.origin === 'discord');
	const canEdit = $derived(own && !mirrored);

	let picking = $state(false);

	function pick(emoji: string): void {
		picking = false;
		const existing = message.reactions.find((r) => r.emoji === emoji);
		void timeline.react(message, emoji, !(existing?.me ?? false)).catch(() => undefined);
	}
</script>

{#snippet action(label: string, onclick: () => void, Icon: typeof Reply, danger = false)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					aria-label={label}
					{onclick}
					class="flex size-8 items-center justify-center text-interactive hover:bg-hovered {danger
						? 'hover:text-dnd'
						: 'hover:text-normal'}"
				>
					<Icon class="size-[18px]" />
				</button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<article
	class="group relative py-0.5 hover:bg-black/[0.06] focus-within:bg-black/[0.06] {grouped ? '' : 'mt-[17px]'}"
	aria-label="{name}, {formatFull(date)}"
>
	{#if message.replyTo !== 0n && !deleted}
		<ReplyQuote channelId={message.channelId} replyTo={message.replyTo} loaded={replied} {onjump} />
	{/if}
	<div class="relative min-h-[22px] pr-4 pl-[72px] sm:pr-12">
		{#if grouped}
			<time
				class="absolute left-0 w-[72px] text-center text-[11px] leading-[22px] text-faint opacity-0 group-hover:opacity-100"
				datetime={date.toISOString()}
				title={formatFull(date)}>{formatTime(date)}</time
			>
		{:else}
			<div class="absolute top-0.5 left-4">
				<UserAvatar id={author?.id ?? ''} {name} src={author?.avatarUrl} accent={author?.accentColor} size={40} />
			</div>
			<h3 class="flex min-w-0 items-baseline gap-2 leading-[22px]">
				<span class="truncate font-medium" style:color={author?.accentColor || '#ffffff'}>{name}</span>
				{#if automated}
					<span class="rounded bg-blurple px-1 text-[10px] leading-4 font-semibold text-white uppercase"
						>{author?.kind}</span
					>
				{/if}
				{#if mirrored}
					<span
						class="rounded bg-hover/60 px-1 text-[10px] leading-4 font-semibold text-interactive uppercase"
						title="Written in Discord">Discord</span
					>
				{/if}
				<time class="shrink-0 text-xs text-faint" datetime={date.toISOString()} title={formatFull(date)}
					>{formatStamp(date)}</time
				>
			</h3>
		{/if}
		{#if deleted}
			<p class="leading-[22px] text-faint italic">This message was deleted</p>
		{:else if editing}
			<MessageEditor {message} ondone={oneditdone} />
		{:else}
			{#if message.content}
				<div class="leading-[22px] text-normal">
					<MessageText text={message.content} />
					{#if edited}
						<span class="text-[10px] text-faint" title="Edited {formatFull(edited)}">(edited)</span>
					{/if}
				</div>
			{/if}
			{#if message.attachments.length > 0}
				<Attachments attachments={message.attachments} />
			{/if}
			{#if message.card}
				<CardView card={message.card} seq={message.seq} />
			{/if}
			<Reactions {message} />
		{/if}
	</div>
	{#if !deleted && !editing}
		<div
			class="absolute -top-4 right-4 z-10 hidden overflow-hidden rounded border border-tertiary bg-chat shadow-md group-hover:flex group-focus-within:flex {picking
				? '!flex'
				: ''}"
		>
			{@render action('Add reaction', () => (picking = !picking), SmilePlus)}
			{@render action('Reply', onreply, Reply)}
			{#if canThread}
				{@render action('Create thread', onthread, MessageSquarePlus)}
			{/if}
			{#if canEdit}
				{@render action('Edit', onedit, Pencil)}
			{/if}
			{#if canDelete}
				{@render action('Delete', ondelete, Trash2, true)}
			{/if}
		</div>
		{#if picking}
			<div class="absolute top-5 right-4 z-20">
				<EmojiPicker onpick={pick} onclose={() => (picking = false)} />
			</div>
		{/if}
	{/if}
</article>
