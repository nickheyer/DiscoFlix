<script lang="ts">
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import { catalogClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { MAX_PEERS, parsePeers } from '#lib/catalog/config';
	import DatasetRow from '#lib/catalog/DatasetRow.svelte';
	import { catalogStatusKey, catalogStatusQuery } from '#lib/catalog/queries';
	import SourceRow from '#lib/catalog/SourceRow.svelte';
	import { catalogBusy, snapshotState } from '#lib/catalog/states';
	import StateBadge from '#lib/catalog/StateBadge.svelte';
	import { session } from '#lib/identity/session.svelte';
	import { formatBytes, formatCount, formatShort, toDate } from '#lib/theme/format';
	import AdminOnly from '#lib/ui/AdminOnly.svelte';
	import { Button } from '#lib/ui/button';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';
	import SettingsSection from '#lib/ui/SettingsSection.svelte';

	const POLL_MS = 10_000;

	const client = useQueryClient();
	const status = createQuery(() => ({
		...catalogStatusQuery(),
		enabled: session.isAdmin,
		refetchInterval: (q) => (catalogBusy(q.state.data) ? POLL_MS : false)
	}));
	const st = $derived(status.data);
	const snapshot = $derived(st?.snapshot);
	const busy = $derived(catalogBusy(st));

	const vias: Record<string, string> = { http: 'HTTP mirror', peer: 'Peer' };

	let mirror = $state('');
	let peersText = $state('');
	let language = $state('');
	let formFilled = false;
	let saving = $state(false);
	let saveError = $state('');
	let saved = $state(false);

	let updating = $state(false);
	let updateError = $state('');
	let snapshotWorkflow = $state('');

	$effect(() => {
		const data = status.data;
		if (!data || formFilled) return;
		formFilled = true;
		untrack(() => {
			mirror = data.snapshot?.mirror ?? '';
			peersText = data.peers.join('\n');
			language = data.language;
		});
	});

	async function reload(): Promise<void> {
		await client.invalidateQueries({ queryKey: catalogStatusKey() });
	}

	async function updateNow(): Promise<void> {
		updating = true;
		updateError = '';
		try {
			const res = await catalogClient.updateSnapshot({});
			snapshotWorkflow = res.workflowId;
			await reload();
		} catch (err) {
			updateError = errorText(err);
		} finally {
			updating = false;
		}
	}

	// Saves mirror, peers, and language, then shows the values the server kept
	async function saveCatalog(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		saved = false;
		const parsed = parsePeers(peersText);
		if (parsed.error) {
			saveError = parsed.error;
			return;
		}
		saving = true;
		saveError = '';
		try {
			const res = await catalogClient.configureCatalog({
				mirrorUrl: mirror.trim(),
				peers: parsed.peers,
				language: language.trim()
			});
			mirror = res.snapshot?.mirror ?? mirror.trim();
			peersText = res.peers.join('\n');
			language = res.language;
			saved = true;
			await reload();
		} catch (err) {
			saveError = errorText(err);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet stat(label: string, value: string, mono = false)}
	<div class="min-w-0">
		<dt class="text-xs font-semibold text-interactive">{label}</dt>
		<dd class="truncate {mono ? 'font-mono text-xs' : 'text-sm'} text-normal" title={value}>{value}</dd>
	</div>
{/snippet}

<AdminOnly>
	{#if status.isError}
		<p class="mb-4 rounded bg-dnd/15 p-3 text-sm text-dnd" role="alert">{errorText(status.error)}</p>
		<Button variant="secondary" onclick={() => status.refetch()}>Retry</Button>
	{:else if status.isPending}
		<p class="text-sm text-faint" role="status">Loading catalog status</p>
	{:else if st}
		{#if busy}
			<p class="mb-4 flex items-center gap-2 text-xs text-interactive" role="status">
				<RefreshCw class="size-3.5 animate-spin" />
				Work is in progress, this page checks again every {POLL_MS / 1000} seconds
			</p>
		{/if}

		<SettingsSection
			title="Snapshot"
			description="The signed crosswalk that resolves ids offline, fetched from the mirror or from peers"
		>
			<div class="space-y-3 rounded-lg bg-sidebar px-4 py-3">
				<div class="flex flex-wrap items-center gap-2">
					<StateBadge {...snapshotState(snapshot?.state ?? 'missing')} />
					<span class="font-mono text-sm text-header">{snapshot?.version || 'No snapshot installed'}</span>
					<Button size="sm" class="ml-auto" disabled={updating || snapshot?.state === 'updating'} onclick={updateNow}>
						{updating ? 'Starting' : snapshot?.state === 'updating' ? 'Updating' : 'Update now'}
					</Button>
				</div>
				<dl class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
					{@render stat('Built', formatShort(toDate(snapshot?.builtAt)))}
					{@render stat('Items', formatCount(snapshot?.items ?? 0n))}
					{@render stat('External ids', formatCount(snapshot?.externalIds ?? 0n))}
					{@render stat('Size', formatBytes(snapshot?.bytes ?? 0n))}
					{@render stat('Fetched via', vias[snapshot?.via ?? ''] ?? (snapshot?.via || 'Not fetched yet'))}
					{@render stat('Checked', formatShort(toDate(snapshot?.checkedAt)))}
					{@render stat('Updated', formatShort(toDate(snapshot?.updatedAt)))}
				</dl>
				{#if snapshot?.lastError}
					<p class="rounded bg-dnd/10 p-2 text-xs break-words text-dnd" role="alert">{snapshot.lastError}</p>
				{/if}
				{#if snapshotWorkflow}
					<p class="flex flex-wrap items-center gap-2 text-xs text-interactive" role="status">
						Update running as workflow
						<code class="rounded bg-tertiary px-1.5 py-0.5 font-mono text-normal">{snapshotWorkflow}</code>
						<CopyButton value={snapshotWorkflow} label="Copy id" />
					</p>
				{/if}
				{#if updateError}
					<p class="text-sm text-dnd" role="alert">{updateError}</p>
				{/if}
			</div>
			<form class="mt-4 space-y-3" onsubmit={saveCatalog}>
				<div class="space-y-1">
					<Label for="catalog-mirror" class="text-xs font-bold tracking-wide text-interactive uppercase"
						>Mirror URL</Label
					>
					<Input
						id="catalog-mirror"
						type="url"
						bind:value={mirror}
						maxlength={512}
						autocomplete="off"
						placeholder="https://mirror.example/crosswalk"
						class="h-10 border-0 bg-tertiary font-mono"
					/>
				</div>
				<div class="space-y-1">
					<Label for="catalog-peers" class="text-xs font-bold tracking-wide text-interactive uppercase">
						Peers, one per line, up to {MAX_PEERS}
					</Label>
					<textarea
						id="catalog-peers"
						bind:value={peersText}
						rows={4}
						spellcheck={false}
						class="w-full resize-y rounded-lg bg-tertiary px-2.5 py-2 font-mono text-sm text-normal outline-none scroll-thin focus:ring-2 focus:ring-ring"
					></textarea>
				</div>
				<div class="space-y-1">
					<Label for="catalog-language" class="text-xs font-bold tracking-wide text-interactive uppercase"
						>Preferred language</Label
					>
					<Input
						id="catalog-language"
						bind:value={language}
						maxlength={8}
						autocomplete="off"
						placeholder="en"
						class="h-10 w-32 border-0 bg-tertiary font-mono"
					/>
				</div>
				<div class="flex flex-wrap items-center gap-3">
					<Button type="submit" disabled={saving}>{saving ? 'Saving' : 'Save'}</Button>
					{#if saved}
						<span class="text-sm text-online" role="status">Saved</span>
					{/if}
				</div>
				{#if saveError}
					<p class="text-sm text-dnd" role="alert">{saveError}</p>
				{/if}
			</form>
		</SettingsSection>

		<SettingsSection title="Sources" description="Every live metadata source is optional, enable and key them here">
			{#if st.sources.length === 0}
				<p class="text-sm text-faint">No metadata source is registered on this server</p>
			{:else}
				<ul class="divide-y divide-divider rounded-lg bg-sidebar">
					{#each st.sources as source (source.name)}
						<SourceRow {source} onsaved={reload} />
					{/each}
				</ul>
			{/if}
		</SettingsSection>

		<SettingsSection
			title="Datasets"
			description="Bulk dumps imported into the local graph so resolution needs no live API"
		>
			{#if st.datasets.length === 0}
				<p class="text-sm text-faint">No bulk dataset is registered on this server</p>
			{:else}
				<ul class="divide-y divide-divider rounded-lg bg-sidebar">
					{#each st.datasets as dataset (dataset.dataset)}
						<DatasetRow {dataset} onchanged={reload} />
					{/each}
				</ul>
			{/if}
		</SettingsSection>

		<SettingsSection
			title="Matcher"
			description="Scores doubtful matches and retrains from every accepted or rejected review"
		>
			<dl class="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-sidebar px-4 py-3 sm:grid-cols-4">
				{@render stat('Trained', formatShort(toDate(st.model?.trainedAt)))}
				{@render stat('Training pairs', formatCount(st.model?.pairs ?? 0n))}
				{@render stat('Accepted', formatCount(st.model?.accepted ?? 0n))}
				{@render stat('Rejected', formatCount(st.model?.rejected ?? 0n))}
				{@render stat('Pending reviews', formatCount(st.model?.pendingReviews ?? 0n))}
				{@render stat('Entities', formatCount(st.entities))}
				{@render stat('Claims', formatCount(st.claims))}
				{@render stat('Artwork', formatCount(st.artworks))}
			</dl>
		</SettingsSection>
	{/if}
</AdminOnly>
