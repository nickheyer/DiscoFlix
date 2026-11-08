<script lang="ts">
	import { catalogClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import type { Source } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
	import { formatAgo, formatCount, formatFull, toDate } from '#lib/theme/format';
	import { segments } from '#lib/timeline/linkify';
	import { Button } from '#lib/ui/button';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';
	import { Switch } from '#lib/ui/switch';
	import { overBudget } from './config';
	import { namespaceLabel } from './entity';
	import { sourceState } from './states';
	import StateBadge from './StateBadge.svelte';

	let { source, onsaved }: { source: Source; onsaved: () => Promise<void> } = $props();

	let apiKey = $state('');
	let clientKey = $state('');
	let busy = $state(false);
	let error = $state('');
	let clearOpen = $state(false);

	const lastOk = $derived(toDate(source.lastOkAt));
	const lastFailed = $derived(toDate(source.lastErrorAt));
	const hint = $derived(segments(source.keyHint));
	const keysStored = $derived((source.needsKey && source.configured) || source.hasClientKey);
	const spent = $derived(overBudget(source));

	// Sends enabled, keys, and the stored options together so nothing configured is lost
	async function send(change: { enabled: boolean; apiKey?: string; clientKey?: string; clearKeys?: boolean }) {
		await catalogClient.configureSource({
			source: source.name,
			enabled: change.enabled,
			apiKey: change.apiKey ?? '',
			clientKey: change.clientKey ?? '',
			options: { ...source.options },
			clearKeys: change.clearKeys ?? false
		});
		await onsaved();
	}

	async function run(action: () => Promise<void>): Promise<boolean> {
		busy = true;
		error = '';
		try {
			await action();
			return true;
		} catch (err) {
			error = errorText(err);
			return false;
		} finally {
			busy = false;
		}
	}

	async function saveKeys(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const ok = await run(() => send({ enabled: source.enabled, apiKey: apiKey.trim(), clientKey: clientKey.trim() }));
		if (ok) {
			apiKey = '';
			clientKey = '';
		}
	}
</script>

<li class="space-y-3 px-4 py-3">
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-semibold text-header">{source.title || source.name}</span>
		<span class="font-mono text-xs text-faint">{source.name}</span>
		<StateBadge {...sourceState(source.state)} />
		<label class="ml-auto flex items-center gap-2 text-xs text-interactive">
			Enabled
			<Switch
				aria-label="Enable {source.title || source.name}"
				bind:checked={() => source.enabled, (on) => void run(() => send({ enabled: on }))}
				disabled={busy}
			/>
		</label>
	</div>
	<dl class="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
		<div class="flex gap-1.5">
			<dt class="text-faint">Calls today</dt>
			<dd class={spent ? 'font-semibold text-dnd' : 'text-normal'}>
				{source.budget > 0
					? `${formatCount(source.callsToday)} of ${formatCount(source.budget)}${spent ? ', over budget' : ''}`
					: `${formatCount(source.callsToday)}, no daily budget`}
			</dd>
		</div>
		<div class="flex gap-1.5">
			<dt class="text-faint">Last answered</dt>
			<dd class="text-normal">
				{#if lastOk}
					<time datetime={lastOk.toISOString()} title={formatFull(lastOk)}>{formatAgo(lastOk)}</time>
				{:else}
					Never
				{/if}
			</dd>
		</div>
		<div class="flex gap-1.5">
			<dt class="text-faint">Last failed</dt>
			<dd class="text-normal">
				{#if lastFailed}
					<time datetime={lastFailed.toISOString()} title={formatFull(lastFailed)}>{formatAgo(lastFailed)}</time>
				{:else}
					Never
				{/if}
			</dd>
		</div>
		{#if source.license}
			<div class="flex gap-1.5">
				<dt class="text-faint">License</dt>
				<dd class="min-w-0 break-words text-normal">{source.license}</dd>
			</div>
		{/if}
		{#if source.namespaces.length > 0}
			<div class="flex flex-wrap items-center gap-1.5 sm:col-span-2">
				<dt class="text-faint">Ids</dt>
				{#each source.namespaces as ns (ns)}
					<dd class="rounded bg-tertiary px-1.5 py-0.5 text-[11px] text-normal">{namespaceLabel(ns)}</dd>
				{/each}
			</div>
		{/if}
	</dl>
	{#if source.lastError}
		<p class="rounded bg-dnd/10 px-2 py-1.5 text-xs break-words text-dnd">{source.lastError}</p>
	{/if}
	{#if source.needsKey}
		<form class="space-y-2" onsubmit={saveKeys}>
			{#if source.keyHint}
				<p class="text-xs text-interactive">
					{#each hint as part, i (i)}
						{#if part.href}
							<a href={part.href} target="_blank" rel="noopener noreferrer" class="text-link hover:underline"
								>{part.text}</a
							>
						{:else}
							{part.text}
						{/if}
					{/each}
				</p>
			{/if}
			<div class="grid gap-2 sm:grid-cols-2">
				<div class="space-y-1">
					<Label for="{source.name}-api-key" class="text-xs font-bold tracking-wide text-interactive uppercase"
						>API key</Label
					>
					<Input
						id="{source.name}-api-key"
						type="password"
						bind:value={apiKey}
						autocomplete="off"
						placeholder={source.configured ? 'Stored, paste to replace' : 'Paste the API key'}
						class="h-9 border-0 bg-tertiary font-mono"
					/>
				</div>
				<div class="space-y-1">
					<Label for="{source.name}-client-key" class="text-xs font-bold tracking-wide text-interactive uppercase"
						>Client key</Label
					>
					<Input
						id="{source.name}-client-key"
						type="password"
						bind:value={clientKey}
						autocomplete="off"
						placeholder={source.hasClientKey ? 'Stored, paste to replace' : 'Paste the client key'}
						class="h-9 border-0 bg-tertiary font-mono"
					/>
				</div>
			</div>
			<div class="flex flex-wrap gap-2">
				<Button type="submit" size="sm" disabled={busy || (apiKey.trim() === '' && clientKey.trim() === '')}>
					{busy ? 'Saving' : 'Save keys'}
				</Button>
				{#if keysStored}
					<Button variant="destructive" size="sm" disabled={busy} onclick={() => (clearOpen = true)}>Clear keys</Button>
				{/if}
			</div>
		</form>
	{/if}
	{#if error}
		<p class="text-sm text-dnd" role="alert">{error}</p>
	{/if}
</li>

<ConfirmDialog
	bind:open={clearOpen}
	title="Clear {source.title || source.name} keys"
	confirmLabel="Clear keys"
	onconfirm={() => send({ enabled: source.enabled, clearKeys: true })}
>
	Both stored keys are forgotten. The source stops answering until a new key is saved.
</ConfirmDialog>
