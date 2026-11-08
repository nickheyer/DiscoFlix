<script lang="ts">
	import { fromJson } from '@bufbuild/protobuf';
	import { ValueSchema } from '@bufbuild/protobuf/wkt';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Pin from '@lucide/svelte/icons/pin';
	import PinOff from '@lucide/svelte/icons/pin-off';
	import { catalogClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import type { Claim, FieldValue as Field } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
	import { formatAgo, formatFull, formatPercent, humanize, toDate } from '#lib/theme/format';
	import { Button } from '#lib/ui/button';
	import { Input } from '#lib/ui/input';
	import {
		describeValue,
		fieldLabel,
		parsePin,
		pinDraft,
		pinModes,
		sameValue,
		sourceLabel,
		valueJson,
		type PinMode
	} from './entity';
	import FieldValue from './FieldValue.svelte';
	import StateBadge from './StateBadge.svelte';

	let {
		entityId,
		field,
		claims,
		editable,
		onchanged
	}: { entityId: string; field: Field; claims: Claim[]; editable: boolean; onchanged: () => Promise<void> } = $props();

	const json = $derived(valueJson(field.value));
	const view = $derived(describeValue(json, field.field));
	const observedAt = $derived(toDate(field.observedAt));
	const label = $derived(fieldLabel(field.field));

	let showClaims = $state(false);
	let editing = $state(false);
	let mode = $state<PinMode>('text');
	let text = $state('');
	let busy = $state(false);
	let error = $state('');

	function edit(): void {
		const draft = pinDraft(json);
		mode = draft.mode;
		text = draft.text;
		error = '';
		editing = true;
	}

	function changeMode(next: PinMode): void {
		mode = next;
		if (next === 'bool' && text !== 'true' && text !== 'false') text = 'true';
	}

	// Pins the edited value and reloads the entity so the new user claim appears
	async function pin(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const parsed = parsePin(mode, text);
		if (!parsed.ok) {
			error = parsed.error;
			return;
		}
		busy = true;
		error = '';
		try {
			await catalogClient.pinField({ entityId, field: field.field, value: fromJson(ValueSchema, parsed.value) });
			await onchanged();
			editing = false;
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}

	async function unpin(): Promise<void> {
		busy = true;
		error = '';
		try {
			await catalogClient.unpinField({ entityId, field: field.field });
			await onchanged();
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}

	const reasons: Record<string, string> = {
		pin: 'Pinned',
		priority: 'Source priority',
		agreement: 'Agreement',
		recency: 'Most recent'
	};
</script>

<div role="row" class="border-b border-divider px-4 py-3 last:border-b-0">
	<div
		class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 lg:grid-cols-[10rem_minmax(0,1fr)_7rem_6.5rem_6rem_7rem_4.5rem]"
	>
		<div role="rowheader" class="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-header">
			{#if field.pinned}
				<Pin class="size-3.5 shrink-0 text-idle" aria-label="Pinned" />
			{/if}
			<span class="truncate" title={field.field}>{label}</span>
		</div>
		<div role="cell" class="col-span-full min-w-0 text-sm text-normal lg:col-span-1">
			<FieldValue {view} />
		</div>
		<div class="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-interactive lg:contents">
			<span role="cell" class="truncate lg:pt-0.5" title={field.source}>{sourceLabel(field.source)}</span>
			<span role="cell" class="lg:pt-0.5">
				<StateBadge
					label={reasons[field.reason] ?? (humanize(field.reason) || 'Resolved')}
					tone={field.pinned ? 'warning' : 'neutral'}
				/>
			</span>
			<span role="cell" class="lg:pt-0.5">
				<button
					class="inline-flex items-center gap-1 text-link hover:underline"
					aria-expanded={showClaims}
					onclick={() => (showClaims = !showClaims)}
				>
					<ChevronRight class="size-3 transition-transform {showClaims ? 'rotate-90' : ''}" />
					{field.agreement} of {field.claims} agree
				</button>
			</span>
			<span role="cell" class="lg:pt-0.5">
				{#if observedAt}
					<time datetime={observedAt.toISOString()} title={formatFull(observedAt)}>{formatAgo(observedAt)}</time>
				{:else}
					<span class="text-faint">Never observed</span>
				{/if}
			</span>
		</div>
		<div role="cell" class="col-start-2 row-start-1 flex justify-end gap-0.5 lg:col-start-7">
			{#if editable}
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={field.pinned ? `Change pinned ${label}` : `Pin ${label}`}
					title={field.pinned ? 'Change pinned value' : 'Pin a value'}
					disabled={busy}
					onclick={edit}
				>
					<Pencil class="size-4" />
				</Button>
				{#if field.pinned}
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Unpin {label}"
						title="Unpin and let sources decide"
						disabled={busy}
						onclick={unpin}
					>
						<PinOff class="size-4" />
					</Button>
				{/if}
			{/if}
		</div>
	</div>
	{#if editing}
		<form class="mt-3 space-y-2 rounded bg-tertiary/60 p-3" onsubmit={pin}>
			<label class="flex items-center gap-2 text-xs text-interactive">
				Value type
				<select
					class="h-8 rounded bg-tertiary px-2 text-sm text-normal outline-none focus:ring-2 focus:ring-ring"
					value={mode}
					onchange={(e) => changeMode(e.currentTarget.value as PinMode)}
				>
					{#each pinModes as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</label>
			{#if mode === 'bool'}
				<select
					aria-label="Pinned {label}"
					class="h-9 rounded bg-tertiary px-2 text-sm text-normal outline-none focus:ring-2 focus:ring-ring"
					bind:value={text}
				>
					<option value="true">Yes</option>
					<option value="false">No</option>
				</select>
			{:else if mode === 'number'}
				<Input
					aria-label="Pinned {label}"
					inputmode="decimal"
					bind:value={text}
					class="h-9 max-w-xs border-0 bg-tertiary font-mono"
				/>
			{:else}
				<textarea
					aria-label="Pinned {label}"
					bind:value={text}
					rows={mode === 'json' ? 6 : 3}
					class="w-full resize-y rounded bg-tertiary px-2.5 py-2 text-sm text-normal outline-none scroll-thin focus:ring-2 focus:ring-ring {mode ===
					'json'
						? 'font-mono text-xs'
						: ''}"></textarea>
			{/if}
			{#if error}
				<p class="text-sm text-dnd" role="alert">{error}</p>
			{/if}
			<div class="flex flex-wrap gap-2">
				<Button type="submit" size="sm" disabled={busy}>{busy ? 'Pinning' : 'Pin value'}</Button>
				<Button variant="ghost" size="sm" disabled={busy} onclick={() => (editing = false)}>Cancel</Button>
			</div>
		</form>
	{:else if error}
		<p class="mt-2 text-sm text-dnd" role="alert">{error}</p>
	{/if}
	{#if showClaims}
		<ul class="mt-3 divide-y divide-divider rounded bg-tertiary/50" aria-label="Claims for {label}">
			{#each claims as claim (claim.id)}
				{@const at = toDate(claim.observedAt)}
				{@const chosen = claim.source === field.source && sameValue(claim.value, field.value)}
				<li class="grid gap-1.5 px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
					<div class="min-w-0"><FieldValue view={describeValue(valueJson(claim.value), claim.field)} /></div>
					<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-interactive sm:justify-end">
						<span class="font-medium text-header" title={claim.recordId || undefined}>{sourceLabel(claim.source)}</span>
						<span title="Source confidence">{formatPercent(claim.confidence)}</span>
						<span title="Source rank, lower wins">rank {claim.rank}</span>
						{#if at}
							<time datetime={at.toISOString()} title={formatFull(at)}>{formatAgo(at)}</time>
						{/if}
						{#if claim.pinned}
							<StateBadge label="Pinned" tone="warning" />
						{/if}
						{#if chosen}
							<StateBadge label="Chosen" tone="success" />
						{/if}
					</div>
				</li>
			{:else}
				<li class="px-3 py-2 text-sm text-faint">No claims recorded for this field</li>
			{/each}
		</ul>
	{/if}
</div>
