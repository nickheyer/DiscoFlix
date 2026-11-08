<script lang="ts">
	import { humanize } from '#lib/theme/format';
	import type { ValueView } from './entity';
	import FieldValue from './FieldValue.svelte';

	let { view }: { view: ValueView } = $props();

	const PEOPLE_SHOWN = 8;
	let open = $state(false);
</script>

{#if view.type === 'empty'}
	<span class="text-faint">None</span>
{:else if view.type === 'bool'}
	<span>{view.value ? 'Yes' : 'No'}</span>
{:else if view.type === 'number'}
	<span class="tabular-nums">{view.text}</span>
{:else if view.type === 'date'}
	<time datetime={view.iso}>{view.text}</time>
{:else if view.type === 'link'}
	<a href={view.href} target="_blank" rel="noopener noreferrer" class="break-all text-link hover:underline"
		>{view.text}</a
	>
{:else if view.type === 'text'}
	<p class="break-words whitespace-pre-wrap {view.long && !open ? 'line-clamp-3' : ''}">{view.text}</p>
	{#if view.long}
		<button class="text-xs text-link hover:underline" aria-expanded={open} onclick={() => (open = !open)}>
			{open ? 'Show less' : 'Show more'}
		</button>
	{/if}
{:else if view.type === 'chips'}
	<ul class="flex flex-wrap gap-1">
		{#each view.items as item, i (i)}
			<li class="rounded bg-tertiary px-1.5 py-0.5 text-xs">{item}</li>
		{/each}
	</ul>
{:else if view.type === 'people'}
	<ul class="space-y-1">
		{#each open ? view.people : view.people.slice(0, PEOPLE_SHOWN) as p, i (i)}
			<li class="flex min-w-0 items-center gap-2">
				{#if p.image}
					<img src={p.image} alt="" loading="lazy" class="size-6 shrink-0 rounded-full bg-tertiary object-cover" />
				{/if}
				<span class="truncate text-header">{p.name}</span>
				{#if p.detail}
					<span class="truncate text-xs text-faint">{p.detail}</span>
				{/if}
			</li>
		{/each}
	</ul>
	{#if view.people.length > PEOPLE_SHOWN}
		<button class="mt-1 text-xs text-link hover:underline" aria-expanded={open} onclick={() => (open = !open)}>
			{open ? 'Show fewer' : `Show all ${view.people.length}`}
		</button>
	{/if}
{:else if view.type === 'image'}
	<a href={view.url} target="_blank" rel="noopener noreferrer" class="inline-block">
		<img src={view.url} alt="" loading="lazy" class="max-h-24 rounded bg-tertiary" />
	</a>
	{#if view.width > 0 && view.height > 0}
		<span class="block text-xs text-faint">{view.width}x{view.height}</span>
	{/if}
{:else if view.type === 'list'}
	<ul class="space-y-1">
		{#each view.items as item, i (i)}
			<li><FieldValue view={item} /></li>
		{/each}
	</ul>
{:else}
	<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
		{#each view.entries as entry (entry.key)}
			<dt class="text-faint">{humanize(entry.key) || entry.key}</dt>
			<dd class="min-w-0"><FieldValue view={entry.view} /></dd>
		{/each}
	</dl>
{/if}
