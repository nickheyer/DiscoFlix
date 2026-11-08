<script lang="ts">
	import { create } from '@bufbuild/protobuf';
	import type { Any } from '@bufbuild/protobuf/wkt';
	import { timelineClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { EventKind, EventSchema } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { timeline } from '#lib/timeline/store.svelte';
	import CardFrame from './CardFrame.svelte';
	import GenericCard from './GenericCard.svelte';
	import { cardAccent, cardActions, cardSummary, resolveCard, type ActionStyle } from './registry';

	let { card, seq = 0n }: { card: Any; seq?: bigint } = $props();

	const resolved = $derived(resolveCard(card));
	const actions = $derived(seq > 0n ? cardActions(resolved) : []);

	let busy = $state('');
	let error = $state('');

	const styles: Record<ActionStyle, string> = {
		primary: 'bg-blurple text-white hover:bg-blurple/85',
		success: 'bg-online text-white hover:bg-online/85',
		danger: 'bg-dnd text-white hover:bg-dnd/85',
		secondary: 'bg-hover text-header hover:bg-hover/80'
	};

	// Sends the action and applies the returned card so this view updates before the event arrives
	async function act(id: string): Promise<void> {
		busy = id;
		error = '';
		try {
			const res = await timelineClient.interactCard({ seq, action: id });
			if (res.message) {
				timeline.dispatch(
					create(EventSchema, {
						seq,
						kind: EventKind.CARD_UPDATED,
						message: res.message,
						channelId: res.message.channelId,
						spaceId: res.message.spaceId
					})
				);
			}
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = '';
		}
	}
</script>

<CardFrame
	accent={cardAccent(resolved)}
	title={cardSummary(resolved)}
	typeLabel={resolved.kind === 'known' ? resolved.typeName : resolved.typeUrl}
>
	{#if resolved.kind === 'known'}
		{@const Renderer = resolved.renderer.component}
		<Renderer card={resolved.message} />
	{:else}
		<GenericCard json={resolved.json} />
	{/if}
	{#if actions.length > 0}
		<div class="mt-3 flex flex-wrap gap-2">
			{#each actions as action (action.id)}
				<button
					onclick={() => act(action.id)}
					disabled={busy !== ''}
					class="rounded px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-60 {styles[action.style]}"
				>
					{busy === action.id ? 'Working' : action.label}
				</button>
			{/each}
		</div>
	{/if}
	{#if error}
		<p class="mt-2 text-sm text-dnd" role="alert">{error}</p>
	{/if}
</CardFrame>
