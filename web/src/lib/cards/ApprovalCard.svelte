<script lang="ts">
	import { ApprovalState, type Approval } from '#lib/gen/discoflix/card/v1/approval_pb';
	import { formatFull, toDate } from '#lib/theme/format';
	import { approvalStateLabel } from './summaries';

	let { card }: { card: Approval } = $props();

	const decidedAt = $derived(toDate(card.decidedAt));
	const tone = $derived(
		card.state === ApprovalState.PENDING
			? 'text-idle'
			: card.state === ApprovalState.EXECUTED
				? 'text-online'
				: card.state === ApprovalState.APPROVED
					? 'text-blurple'
					: 'text-dnd'
	);
</script>

{#if card.body}
	<p class="break-words whitespace-pre-wrap">{card.body}</p>
{/if}
<p class="mt-2 text-xs text-interactive">
	Requested by <span class="font-semibold text-header">{card.requestedByName || card.requestedBy}</span>
	{#if card.requestedVia}
		via {card.requestedVia}
	{/if}
</p>
{#if card.inputJson}
	<details class="mt-2">
		<summary class="cursor-pointer text-xs font-semibold text-interactive select-none">
			Request <code class="rounded bg-tertiary px-1 font-mono text-[11px] text-normal">{card.procedure}</code>
		</summary>
		<pre
			class="mt-1 max-h-60 overflow-auto rounded bg-tertiary p-2 font-mono text-xs whitespace-pre scroll-thin">{card.inputJson}</pre>
	</details>
{/if}
<p class="mt-2 text-sm font-semibold {tone}">
	{approvalStateLabel(card)}
	{#if decidedAt}
		<time class="ml-1 text-xs font-normal text-faint" datetime={decidedAt.toISOString()}>{formatFull(decidedAt)}</time>
	{/if}
</p>
{#if card.result && card.result !== 'Done'}
	<pre
		class="mt-1 max-h-60 overflow-auto rounded bg-tertiary p-2 font-mono text-xs whitespace-pre-wrap scroll-thin">{card.result}</pre>
{/if}
