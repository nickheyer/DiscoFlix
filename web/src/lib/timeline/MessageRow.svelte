<script lang="ts">
	import Pencil from '@lucide/svelte/icons/pencil';
	import Reply from '@lucide/svelte/icons/reply';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import CardView from '#lib/cards/CardView.svelte';
	import type { Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import UserAvatar from '#lib/identity/UserAvatar.svelte';
	import { formatFull, formatStamp, formatTime, toDate } from '#lib/theme/format';
	import * as Tooltip from '#lib/ui/tooltip';
	import MessageEditor from './MessageEditor.svelte';
	import MessageText from './MessageText.svelte';
	import ReplyQuote from './ReplyQuote.svelte';

	let {
		message,
		date,
		grouped,
		own,
		canDelete,
		editing,
		replied,
		onreply,
		onedit,
		ondelete,
		oneditdone,
		onjump
	}: {
		message: Message;
		date: Date;
		grouped: boolean;
		own: boolean;
		canDelete: boolean;
		editing: boolean;
		replied: Message | undefined;
		onreply: () => void;
		onedit: () => void;
		ondelete: () => void;
		oneditdone: () => void;
		onjump: (seq: bigint) => void;
	} = $props();

	const author = $derived(message.author);
	const name = $derived(author?.displayName || 'Unknown user');
	const automated = $derived(author !== undefined && author.kind !== '' && author.kind !== 'person');
	const edited = $derived(toDate(message.editedAt));
	const deleted = $derived(message.deletedAt !== undefined);
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
				<p class="leading-[22px] text-normal">
					<MessageText text={message.content} />
					{#if edited}
						<span class="text-[10px] text-faint" title="Edited {formatFull(edited)}">(edited)</span>
					{/if}
				</p>
			{/if}
			{#if message.card}
				<CardView card={message.card} />
			{/if}
		{/if}
	</div>
	{#if !deleted && !editing}
		<div
			class="absolute -top-4 right-4 hidden overflow-hidden rounded border border-tertiary bg-chat shadow-md group-hover:flex group-focus-within:flex"
		>
			{@render action('Reply', onreply, Reply)}
			{#if own}
				{@render action('Edit', onedit, Pencil)}
			{/if}
			{#if canDelete}
				{@render action('Delete', ondelete, Trash2, true)}
			{/if}
		</div>
	{/if}
</article>
