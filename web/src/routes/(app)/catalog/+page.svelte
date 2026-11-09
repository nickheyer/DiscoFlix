<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import { createQuery } from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ConnectError } from '@connectrpc/connect';
	import { errorText } from '#lib/api/errors';
	import { artworkNotice, artworkSourcesFromOutcomes } from '#lib/catalog/artwork';
	import CandidateCard from '#lib/catalog/CandidateCard.svelte';
	import CatalogHeader from '#lib/catalog/CatalogHeader.svelte';
	import { kindOptions, scoreScale } from '#lib/catalog/entity';
	import { resolveQuery, searchQuery } from '#lib/catalog/queries';
	import { MAX_YEAR, parseYear, readSearch, searchHref, type SearchMode } from '#lib/catalog/routes';
	import SourceOutcomes from '#lib/catalog/SourceOutcomes.svelte';
	import EntityCardView from '#lib/cards/EntityCard.svelte';
	import { EntityKind, NoMatchSchema, type SourceOutcome } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
	import { session } from '#lib/identity/session.svelte';
	import { Button } from '#lib/ui/button';
	import { Input } from '#lib/ui/input';
	import { Switch } from '#lib/ui/switch';

	const RESULTS = 24;

	const params = $derived(readSearch(page.url.searchParams));

	let query = $state('');
	let kind = $state<EntityKind>(EntityKind.UNSPECIFIED);
	let year = $state('');
	let localOnly = $state(false);

	$effect(() => {
		const p = params;
		untrack(() => {
			query = p.query;
			kind = p.kind;
			year = p.year > 0 ? String(p.year) : '';
			localOnly = p.localOnly;
		});
	});

	const yearValue = $derived(parseYear(year));
	const yearInvalid = $derived(Number.isNaN(yearValue));

	const search = createQuery(() => ({
		...searchQuery({
			query: params.query,
			kind: params.kind,
			year: params.year,
			localOnly: params.localOnly,
			limit: RESULTS
		}),
		enabled: params.mode === 'search' && params.query !== ''
	}));
	const find = createQuery(() => ({
		...resolveQuery({ title: params.query, kind: params.kind, year: params.year, localOnly: params.localOnly }),
		enabled: params.mode === 'find' && params.query !== ''
	}));

	const noMatch = $derived(find.isError ? ConnectError.from(find.error).findDetails(NoMatchSchema)[0] : undefined);
	const candidates = $derived((search.data?.candidates ?? []).filter((c) => c.entity));
	const alternatives = $derived((find.data?.alternatives ?? []).filter((c) => c.entity));
	const searchScale = $derived(scoreScale(candidates));
	const findScale = $derived(scoreScale(alternatives));

	// Puts the form into the address so results survive reloads and back navigation
	function submit(e: SubmitEvent): void {
		e.preventDefault();
		const submitter = e.submitter as HTMLButtonElement | null;
		const mode: SearchMode = submitter?.value === 'find' ? 'find' : 'search';
		const text = query.trim();
		if (text === '' || yearInvalid) return;
		const href = searchHref({ query: text, kind, year: yearValue, localOnly, mode });
		if (href === page.url.pathname + page.url.search) {
			void (mode === 'find' ? find.refetch() : search.refetch());
			return;
		}
		void goto(href, { reset: false });
	}
</script>

<svelte:head>
	<title>{params.query ? `${params.query} in the catalog` : 'Catalog'}</title>
</svelte:head>

{#snippet artworkHint(sources: SourceOutcome[])}
	{@const notice = artworkNotice(artworkSourcesFromOutcomes(sources))}
	{#if notice.message}
		<p class="rounded-lg bg-sidebar px-4 py-2.5 text-xs text-interactive">
			{notice.message}
			{#if notice.allDisabled && session.isAdmin}
				<a href="/settings/catalog" class="text-link underline">Enable one under Settings &gt; Catalog.</a>
			{/if}
		</p>
	{/if}
{/snippet}

{#snippet skeleton()}
	<div class="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]" role="status" aria-label="Loading">
		{#each [0, 1, 2, 3] as i (i)}
			<div class="flex gap-3 rounded-lg bg-sidebar p-3 sm:flex-col">
				<div class="aspect-[2/3] w-20 animate-pulse rounded bg-hovered sm:w-full"></div>
				<div class="flex-1 space-y-2">
					<div class="h-4 w-3/4 animate-pulse rounded bg-hovered"></div>
					<div class="h-3 w-1/2 animate-pulse rounded bg-hovered"></div>
				</div>
			</div>
		{/each}
	</div>
{/snippet}

<main class="flex min-w-0 flex-1 flex-col bg-chat">
	<CatalogHeader title="Catalog" />
	<div class="min-h-0 flex-1 overflow-y-auto scroll-thin">
		<div class="mx-auto max-w-6xl space-y-5 px-4 py-5 sm:px-6">
			<form class="space-y-2 rounded-lg bg-sidebar p-3" onsubmit={submit} role="search">
				<div class="flex flex-col gap-2 sm:flex-row">
					<div class="relative min-w-0 flex-1">
						<Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
						<Input
							bind:value={query}
							aria-label="Title"
							placeholder="Search movies and series"
							maxlength={200}
							autocomplete="off"
							class="h-10 border-0 bg-tertiary pl-8"
						/>
					</div>
					<div class="flex gap-2">
						<select
							aria-label="Kind"
							bind:value={kind}
							class="h-10 min-w-0 flex-1 rounded-lg bg-tertiary px-2 text-sm text-normal outline-none focus:ring-2 focus:ring-ring sm:flex-none"
						>
							{#each kindOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
						<Input
							bind:value={year}
							aria-label="Year"
							aria-invalid={yearInvalid}
							placeholder="Year"
							inputmode="numeric"
							maxlength={4}
							class="h-10 w-24 shrink-0 border-0 bg-tertiary"
						/>
					</div>
				</div>
				<div class="flex flex-wrap items-center gap-3">
					<label class="flex items-center gap-2 text-sm text-interactive">
						<Switch bind:checked={localOnly} />
						Local only
					</label>
					<span class="hidden text-xs text-faint sm:inline">
						{localOnly
							? 'Search and Find answer from the graph and snapshot alone'
							: 'Search and Find also ask live sources'}
					</span>
					<span class="flex-1"></span>
					<Button type="submit" value="search" disabled={query.trim() === '' || yearInvalid}>Search</Button>
					<Button
						type="submit"
						value="find"
						variant="secondary"
						disabled={query.trim() === '' || yearInvalid}
						title="Resolve the title to one entity with provenance">Find</Button
					>
				</div>
				{#if yearInvalid}
					<p class="text-xs text-dnd" role="alert">Year must be a number from 1 to {MAX_YEAR}</p>
				{/if}
			</form>

			{#if params.query === ''}
				<div class="py-10 text-center">
					<h2 class="text-lg font-semibold text-header">Search the catalog</h2>
					<p class="mx-auto mt-1 max-w-md text-sm text-interactive">
						Search lists ranked matches from the local graph, the snapshot, and live sources. Find resolves a title to
						one entity and shows where every field came from.
					</p>
				</div>
			{:else if params.mode === 'search'}
				{#if search.isPending}
					{@render skeleton()}
				{:else if search.isError}
					<p class="rounded bg-dnd/15 p-3 text-sm text-dnd" role="alert">{errorText(search.error)}</p>
				{:else}
					<SourceOutcomes sources={search.data.sources} />
					{@render artworkHint(search.data.sources)}
					{#if candidates.length === 0}
						<p class="py-6 text-center text-sm text-interactive">Nothing matched {params.query}</p>
					{:else}
						<ul class="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]" aria-label="Results">
							{#each candidates as candidate (candidate.entity?.id)}
								<li><CandidateCard {candidate} scale={searchScale} /></li>
							{/each}
						</ul>
					{/if}
				{/if}
			{:else if find.isPending}
				{@render skeleton()}
			{:else if find.isError}
				<p class="rounded bg-dnd/15 p-3 text-sm text-dnd" role="alert">{errorText(find.error)}</p>
				{#if noMatch}
					<SourceOutcomes sources={noMatch.sources} />
				{/if}
			{:else}
				{#if find.data.card}
					<section
						class="rounded-lg border-l-4 border-l-blurple bg-sidebar p-4 text-sm text-normal"
						aria-label="Best match"
					>
						<EntityCardView card={find.data.card} />
					</section>
				{/if}
				<SourceOutcomes sources={find.data.sources} />
				{@render artworkHint(find.data.sources)}
				{#if alternatives.length > 0}
					<section aria-labelledby="alternatives-heading" class="space-y-2">
						<h2 id="alternatives-heading" class="text-xs font-bold tracking-wide text-interactive uppercase">
							Alternatives
						</h2>
						<ul class="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
							{#each alternatives as candidate (candidate.entity?.id)}
								<li><CandidateCard {candidate} scale={findScale} /></li>
							{/each}
						</ul>
					</section>
				{/if}
			{/if}
		</div>
	</div>
</main>
