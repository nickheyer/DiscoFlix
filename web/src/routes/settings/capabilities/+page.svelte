<script lang="ts">
	import { createQueryOptions } from '@connectrpc/connect-query-core';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { createQuery } from '@tanstack/svelte-query';
	import { SvelteSet } from 'svelte/reactivity';
	import { errorText } from '#lib/api/errors';
	import { transport } from '#lib/api/transport';
	import { CapabilityService, type CapabilityEntry } from '#lib/gen/discoflix/capability/v1/capability_pb';
	import { Effect } from '#lib/gen/discoflix/capability/v1/options_pb';
	import { session } from '#lib/identity/session.svelte';
	import AdminOnly from '#lib/ui/AdminOnly.svelte';
	import { Input } from '#lib/ui/input';
	import { createVirtualList } from '#lib/ui/virtual/list.svelte';

	const capabilities = createQuery(() => ({
		...createQueryOptions(CapabilityService.method.listCapabilities, {}, { transport }),
		enabled: session.isAdmin
	}));

	let filter = $state('');
	const rows = $derived.by(() => {
		const needle = filter.trim().toLowerCase();
		const all = [...(capabilities.data?.capabilities ?? [])].sort((a, b) => a.procedure.localeCompare(b.procedure));
		if (!needle) return all;
		return all.filter((c) =>
			[c.procedure, c.name, c.scope, c.title, c.object?.type ?? ''].some((v) => v.toLowerCase().includes(needle))
		);
	});

	const open = new SvelteSet<string>();
	let scroller = $state<HTMLDivElement>();
	const list = createVirtualList({
		count: () => rows.length,
		scrollElement: () => scroller,
		estimateSize: (i) => (open.has(rows[i]?.procedure ?? '') ? 420 : 52),
		itemKey: (i) => rows[i]?.procedure ?? i
	});

	const effects: Record<Effect, { label: string; tone: string }> = {
		[Effect.UNSPECIFIED]: { label: 'unspecified', tone: 'bg-faint/30 text-interactive' },
		[Effect.READ]: { label: 'read', tone: 'bg-online/20 text-online' },
		[Effect.WRITE]: { label: 'write', tone: 'bg-idle/20 text-idle' },
		[Effect.DESTRUCTIVE]: { label: 'destructive', tone: 'bg-dnd/20 text-dnd' }
	};

	function pretty(json: string): string {
		if (!json) return 'No schema';
		try {
			return JSON.stringify(JSON.parse(json), null, 2);
		} catch {
			return json;
		}
	}

	function toggle(c: CapabilityEntry): void {
		if (open.has(c.procedure)) open.delete(c.procedure);
		else open.add(c.procedure);
	}
</script>

<AdminOnly>
	<div class="mb-3 flex flex-wrap items-center gap-3">
		<Input
			bind:value={filter}
			placeholder="Filter by name, scope, or object"
			aria-label="Filter capabilities"
			class="h-9 max-w-sm border-0 bg-tertiary"
		/>
		{#if capabilities.data}
			<span class="text-sm text-faint">{rows.length} of {capabilities.data.capabilities.length}</span>
		{/if}
	</div>
	{#if capabilities.isError}
		<p class="text-sm text-dnd" role="alert">{errorText(capabilities.error)}</p>
	{:else if capabilities.isPending}
		<p class="text-sm text-faint" role="status">Loading capabilities</p>
	{:else}
		<div class="overflow-hidden rounded-lg bg-sidebar" role="table" aria-label="Capabilities">
			<div
				role="row"
				class="hidden grid-cols-[1.6fr_1fr_0.8fr_1fr_3.5rem_3.5rem] gap-2 border-b border-divider px-4 py-2 text-xs font-bold tracking-wide text-faint uppercase md:grid"
			>
				<span role="columnheader">Capability</span>
				<span role="columnheader">Scope</span>
				<span role="columnheader">Effect</span>
				<span role="columnheader">Object</span>
				<span role="columnheader">Slash</span>
				<span role="columnheader">Public</span>
			</div>
			<div bind:this={scroller} class="max-h-[70vh] overflow-y-auto scroll-thin" role="rowgroup">
				<div class="relative w-full" style:height="{list.size}px">
					{#each list.items as item (item.key)}
						{@const c = rows[item.index]}
						{#if c}
							<div
								data-index={item.index}
								{@attach list.measure}
								role="row"
								class="absolute inset-x-0 top-0 border-b border-divider"
								style:transform="translateY({item.start}px)"
							>
								<button
									class="grid w-full grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 px-4 py-2.5 text-left text-sm hover:bg-hovered md:grid-cols-[1.6fr_1fr_0.8fr_1fr_3.5rem_3.5rem]"
									aria-expanded={open.has(c.procedure)}
									onclick={() => toggle(c)}
								>
									<span role="cell" class="col-span-2 flex min-w-0 items-center gap-1.5 md:col-span-1">
										<ChevronRight
											class="size-4 shrink-0 text-faint transition-transform {open.has(c.procedure) ? 'rotate-90' : ''}"
										/>
										<span class="min-w-0">
											<span class="block truncate font-medium text-header">{c.title || c.name}</span>
											<span class="block truncate font-mono text-[11px] text-faint" title={c.procedure}
												>{c.procedure}</span
											>
										</span>
									</span>
									<span role="cell" class="truncate font-mono text-xs text-normal"
										><span class="text-faint md:hidden">scope </span>{c.scope}</span
									>
									<span role="cell">
										<span class="rounded px-1.5 py-0.5 text-[11px] font-semibold {effects[c.effect].tone}"
											>{effects[c.effect].label}</span
										>
									</span>
									<span role="cell" class="truncate font-mono text-xs text-interactive">
										{c.object ? `${c.object.type}.${c.object.field}` : 'system'}
									</span>
									<span role="cell" class="text-xs {c.slash ? 'text-online' : 'text-faint'}">
										<span class="md:hidden">slash </span>{c.slash ? 'yes' : 'no'}
									</span>
									<span role="cell" class="text-xs {c.public ? 'text-idle' : 'text-faint'}">
										<span class="md:hidden">public </span>{c.public ? 'yes' : 'no'}
									</span>
								</button>
								{#if open.has(c.procedure)}
									<div class="space-y-3 bg-tertiary/40 px-4 py-3 text-sm">
										{#if c.description}
											<p class="text-normal">{c.description}</p>
										{/if}
										<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
											<dt class="text-faint">Input</dt>
											<dd class="font-mono break-all">{c.inputType}</dd>
											<dt class="text-faint">Output</dt>
											<dd class="font-mono break-all">{c.outputType}{c.serverStreaming ? ' (stream)' : ''}</dd>
										</dl>
										<div class="grid gap-3 lg:grid-cols-2">
											<div>
												<h3 class="mb-1 text-xs font-bold text-faint uppercase">Input schema</h3>
												<pre
													class="max-h-72 overflow-auto rounded bg-tertiary p-2 font-mono text-xs scroll-thin">{pretty(
														c.inputSchemaJson
													)}</pre>
											</div>
											<div>
												<h3 class="mb-1 text-xs font-bold text-faint uppercase">Output schema</h3>
												<pre
													class="max-h-72 overflow-auto rounded bg-tertiary p-2 font-mono text-xs scroll-thin">{pretty(
														c.outputSchemaJson
													)}</pre>
											</div>
										</div>
									</div>
								{/if}
							</div>
						{/if}
					{/each}
				</div>
			</div>
		</div>
	{/if}
</AdminOnly>
