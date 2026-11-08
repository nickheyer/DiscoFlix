<script lang="ts">
	import { Code } from '@connectrpc/connect';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { catalogClient } from '#lib/api/clients';
	import { errorText, hasCode } from '#lib/api/errors';
	import { EntityKind } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
	import { session } from '#lib/identity/session.svelte';
	import { formatAgo, formatBytes, formatFull, formatTime, humanize, toDate } from '#lib/theme/format';
	import { Button } from '#lib/ui/button';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import { aspectRatio, sortVariants } from './artwork';
	import CatalogHeader from './CatalogHeader.svelte';
	import {
		childrenHeading,
		childTitle,
		groupClaims,
		kindLabel,
		sortChildren,
		sourceLabel
	} from './entity';
	import ExternalLinks from './ExternalLinks.svelte';
	import FieldRow from './FieldRow.svelte';
	import Poster from './Poster.svelte';
	import { entityKey, entityQuery } from './queries';
	import { entityPath } from './routes';
	import StateBadge from './StateBadge.svelte';

	let { id }: { id: string } = $props();

	const RELOAD_AFTER_MS = 5000;
	const COLUMNS = 'lg:grid-cols-[10rem_minmax(0,1fr)_7rem_6.5rem_6rem_7rem_4.5rem]';

	const client = useQueryClient();
	const query = createQuery(() => entityQuery(id));
	const entity = $derived(query.data?.entity);
	const claims = $derived(groupClaims(query.data?.claims ?? []));
	const children = $derived(sortChildren(query.data?.children ?? []));
	const artwork = $derived(query.data?.artwork ?? []);
	const refs = $derived(
		(entity?.externalIds ?? []).map((x) => ({
			namespace: x.namespace,
			value: x.value,
			url: x.url,
			pMatch: x.pMatch
		}))
	);
	const createdAt = $derived(toDate(entity?.createdAt));
	const updatedAt = $derived(toDate(entity?.updatedAt));
	const ordinal = $derived(
		entity?.kind === EntityKind.SEASON
			? `Season ${entity.ordinal}`
			: entity?.kind === EntityKind.EPISODE
				? `Episode ${entity.ordinal}`
				: ''
	);
	const parentLabel = $derived(
		entity?.parentTitle
			? `Open ${entity.parentTitle}`
			: entity?.kind === EntityKind.SEASON
				? 'Open the series'
				: entity?.kind === EntityKind.EPISODE
					? 'Open the season'
					: 'Open the parent entry'
	);

	let phase = $state<'idle' | 'starting' | 'waiting' | 'reloaded'>('idle');
	let workflowId = $state('');
	let refreshError = $state('');
	let reloadedAt = $state<Date | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function reload(): Promise<void> {
		await client.invalidateQueries({ queryKey: entityKey(id) });
	}

	// Starts the refresh workflow and reloads the entity after the sources have had a few seconds
	async function refresh(): Promise<void> {
		phase = 'starting';
		refreshError = '';
		clearTimeout(timer);
		try {
			const res = await catalogClient.refreshEntity({ entityId: id });
			workflowId = res.workflowId;
			phase = 'waiting';
			timer = setTimeout(async () => {
				await reload();
				reloadedAt = new Date();
				phase = 'reloaded';
			}, RELOAD_AFTER_MS);
		} catch (err) {
			refreshError = errorText(err);
			phase = 'idle';
		}
	}

	onDestroy(() => clearTimeout(timer));
</script>

<svelte:head>
	<title>{entity?.title || 'Catalog entity'}</title>
</svelte:head>

<main class="flex min-w-0 flex-1 flex-col bg-chat">
	<CatalogHeader title={entity?.title || 'Catalog entity'}>
		{#if session.isAdmin && entity}
			<Button
				variant="secondary"
				size="sm"
				aria-label="Refresh from every enabled source"
				disabled={phase === 'starting' || phase === 'waiting'}
				onclick={refresh}
			>
				<RefreshCw class="size-4 {phase === 'starting' || phase === 'waiting' ? 'animate-spin' : ''}" />
				<span class="hidden sm:inline">Refresh</span>
			</Button>
		{/if}
	</CatalogHeader>
	<div class="min-h-0 flex-1 overflow-y-auto scroll-thin">
		{#if query.isPending}
			<div class="mx-auto flex max-w-5xl gap-4 px-4 pt-6 sm:px-6" role="status" aria-label="Loading entity">
				<div class="aspect-[2/3] w-28 shrink-0 animate-pulse rounded-lg bg-hovered sm:w-44"></div>
				<div class="flex-1 space-y-3 pt-2">
					<div class="h-6 w-2/3 animate-pulse rounded bg-hovered"></div>
					<div class="h-4 w-1/3 animate-pulse rounded bg-hovered"></div>
					<div class="h-4 w-full animate-pulse rounded bg-hovered"></div>
				</div>
			</div>
		{:else if query.isError}
			<div class="flex flex-col items-center justify-center gap-2 p-10 text-center">
				<h2 class="text-xl font-semibold text-header">
					{hasCode(query.error, Code.NotFound) ? 'Entity not found' : 'The entity failed to load'}
				</h2>
				<p class="max-w-md text-sm text-interactive" role="alert">{errorText(query.error)}</p>
				<div class="flex gap-3">
					<Button variant="secondary" onclick={() => query.refetch()}>Retry</Button>
					<Button variant="ghost" href="/catalog">Search the catalog</Button>
				</div>
			</div>
		{:else if entity}
			{#if entity.backdrop}
				<div class="relative h-44 sm:h-72">
					<Poster
						src={entity.backdrop.url}
						thumbhash={entity.backdrop.thumbhash}
						variants={entity.backdrop.variants}
						sizes="100vw"
						alt=""
						class="absolute inset-0 size-full bg-chat"
					/>
					<div class="absolute inset-0 bg-linear-to-t from-chat via-chat/50 to-chat/0"></div>
				</div>
			{/if}
			<div
				class="relative mx-auto max-w-5xl space-y-8 px-4 pb-16 sm:px-6 {entity.backdrop ? '-mt-24 sm:-mt-36' : 'pt-6'}"
			>
				<section class="space-y-4" aria-label="Overview">
					<div class="flex items-end gap-4 sm:gap-6">
						<Poster
							src={entity.poster?.url ?? ''}
							thumbhash={entity.poster?.thumbhash ?? ''}
							variants={entity.poster?.variants ?? []}
							sizes="(min-width: 640px) 176px, 112px"
							alt="{entity.title} poster"
							class="aspect-[2/3] w-28 shrink-0 rounded-lg shadow-lg sm:w-44"
						/>
						<div class="min-w-0 flex-1 space-y-1 pb-1">
							<h2 class="text-xl font-bold break-words text-header sm:text-3xl">{entity.title || 'Untitled'}</h2>
							{#if entity.originalTitle && entity.originalTitle !== entity.title}
								<p class="text-sm break-words text-interactive italic">{entity.originalTitle}</p>
							{/if}
							<div class="flex flex-wrap items-center gap-2 text-sm text-interactive">
								{#if entity.year > 0}
									<span>{entity.year}</span>
								{/if}
								<StateBadge label={kindLabel(entity.kind)} tone="neutral" />
								{#if ordinal}
									<span>{ordinal}</span>
								{/if}
							</div>
							{#if entity.parentId}
								<a href={entityPath(entity.parentId)} class="inline-block text-sm text-link hover:underline"
									>{parentLabel}</a
								>
							{/if}
						</div>
					</div>
					{#if entity.mergedIntoId}
						<p class="rounded bg-idle/15 p-3 text-sm text-idle" role="status">
							This entry was merged into another entity.
							<a href={entityPath(entity.mergedIntoId)} class="font-semibold underline">Open the merged entity</a>
						</p>
					{/if}
					{#if entity.overview}
						<p class="max-w-3xl break-words whitespace-pre-wrap text-normal">{entity.overview}</p>
					{/if}
					<ExternalLinks {refs} />
					<p class="text-xs text-faint">
						{#if createdAt}
							Added <time datetime={createdAt.toISOString()} title={formatFull(createdAt)}>{formatAgo(createdAt)}</time
							>{updatedAt ? ',' : ''}
						{/if}
						{#if updatedAt}
							{createdAt ? 'updated' : 'Updated'}
							<time datetime={updatedAt.toISOString()} title={formatFull(updatedAt)}>{formatAgo(updatedAt)}</time>
						{/if}
					</p>
					{#if phase === 'waiting' || phase === 'reloaded'}
						<div class="flex flex-wrap items-center gap-2 rounded bg-sidebar px-3 py-2 text-sm" role="status">
							<span class="text-interactive">
								{phase === 'waiting'
									? 'Refreshing from every enabled source, this page reloads in a few seconds'
									: `Reloaded at ${reloadedAt ? formatTime(reloadedAt) : ''} after starting the refresh`}
							</span>
							{#if workflowId}
								<code class="rounded bg-tertiary px-1.5 py-0.5 font-mono text-xs text-normal">{workflowId}</code>
								<CopyButton value={workflowId} label="Copy workflow id" />
							{/if}
						</div>
					{/if}
					{#if refreshError}
						<p class="text-sm text-dnd" role="alert">{refreshError}</p>
					{/if}
				</section>

				<section aria-labelledby="fields-heading">
					<h3 id="fields-heading" class="mb-2 text-xs font-bold tracking-wide text-interactive uppercase">
						Fields and provenance
					</h3>
					<div role="table" aria-labelledby="fields-heading" class="overflow-hidden rounded-lg bg-sidebar">
						<div
							role="row"
							class="hidden gap-x-3 border-b border-divider px-4 py-2 text-xs font-bold tracking-wide text-faint uppercase lg:grid {COLUMNS}"
						>
							<span role="columnheader">Field</span>
							<span role="columnheader">Value</span>
							<span role="columnheader">Source</span>
							<span role="columnheader">Reason</span>
							<span role="columnheader">Claims</span>
							<span role="columnheader">Observed</span>
							<span role="columnheader" class="sr-only">Actions</span>
						</div>
						{#each entity.fields as field (field.field)}
							<FieldRow
								entityId={entity.id}
								{field}
								claims={claims.get(field.field) ?? []}
								editable={session.isAdmin}
								onchanged={reload}
							/>
						{:else}
							<div role="row" class="px-4 py-3 text-sm text-faint">
								<span role="cell">No field has been resolved for this entity</span>
							</div>
						{/each}
					</div>
				</section>

				{#if children.length > 0}
					<section aria-labelledby="children-heading">
						<h3 id="children-heading" class="mb-2 text-xs font-bold tracking-wide text-interactive uppercase">
							{childrenHeading(entity.kind)}
						</h3>
						<ul class="divide-y divide-divider overflow-hidden rounded-lg bg-sidebar">
							{#each children as child (child.id)}
								{@const title = childTitle(child)}
								{@const art = child.poster ?? child.backdrop}
								<li>
									<a href={entityPath(child.id)} class="flex items-center gap-3 px-4 py-2.5 hover:bg-hovered">
										<Poster
											src={art?.url ?? ''}
											thumbhash={art?.thumbhash ?? ''}
											variants={art?.variants ?? []}
											sizes="64px"
											alt=""
											class="shrink-0 rounded {child.kind === EntityKind.EPISODE
												? 'aspect-video w-16'
												: 'aspect-[2/3] w-10'}"
										/>
										<span class="min-w-0 flex-1">
											<span class="block truncate font-medium text-header">{title.primary}</span>
											{#if title.secondary}
												<span class="block truncate text-xs text-faint">{title.secondary}</span>
											{/if}
										</span>
										{#if child.year > 0}
											<span class="shrink-0 text-xs text-interactive">{child.year}</span>
										{/if}
										<ChevronRight class="size-4 shrink-0 text-faint" />
									</a>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if artwork.length > 0}
					<section aria-labelledby="artwork-heading">
						<h3 id="artwork-heading" class="mb-2 text-xs font-bold tracking-wide text-interactive uppercase">
							Artwork
						</h3>
						<ul class="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 lg:grid-cols-4">
							{#each artwork as art (art.id)}
								<li class="flex flex-col overflow-hidden rounded-lg bg-sidebar">
									<a
										href={art.url}
										target="_blank"
										rel="noopener noreferrer"
										aria-label="Open the original {humanize(art.kind).toLowerCase()} from {sourceLabel(art.source)}"
									>
										<Poster
											src={art.url}
											thumbhash={art.thumbhash}
											variants={art.variants}
											sizes="(min-width: 1024px) 240px, (min-width: 640px) 30vw, 45vw"
											alt=""
											ratio={aspectRatio(art, '2 / 3')}
											class="w-full"
										/>
									</a>
									<div class="space-y-1 p-2 text-xs">
										<p class="flex flex-wrap items-center gap-x-1.5">
											<span class="font-semibold text-header">{humanize(art.kind) || 'Artwork'}</span>
											<span class="text-faint">{sourceLabel(art.source)}</span>
											{#if art.language}
												<span class="text-faint uppercase">{art.language}</span>
											{/if}
										</p>
										{#if art.width > 0 && art.height > 0}
											<p class="text-faint">{art.width}x{art.height}</p>
										{/if}
										{#if art.variants.length > 0}
											<ul class="flex flex-wrap gap-1" aria-label="Encoded variants">
												{#each sortVariants(art.variants) as v (v.url)}
													<li>
														<a
															href={v.url}
															target="_blank"
															rel="noopener noreferrer"
															class="inline-block rounded bg-tertiary px-1.5 py-0.5 font-mono text-[11px] text-link hover:underline"
															>{v.format} {v.width}w, {formatBytes(v.bytes)}</a
														>
													</li>
												{/each}
											</ul>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>
		{/if}
	</div>
</main>
