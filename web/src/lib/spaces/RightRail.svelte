<script lang="ts">
	import MembersPanel from '#lib/identity/MembersPanel.svelte';
	import ActivityPanel from '#lib/timeline/ActivityPanel.svelte';

	let { spaceId }: { spaceId: string } = $props();

	let tab = $state<'activity' | 'members'>('members');
	const current = $derived(spaceId === '' ? 'activity' : tab);
</script>

<aside aria-label="Activity and members" class="flex h-full w-60 shrink-0 flex-col bg-sidebar">
	<div
		role="tablist"
		aria-label="Right panel"
		class="flex h-12 shrink-0 items-center gap-1 px-2 shadow-[0_1px_0_rgba(4,4,5,0.2)]"
	>
		{#if spaceId !== ''}
			<button
				role="tab"
				aria-selected={current === 'members'}
				onclick={() => (tab = 'members')}
				class="rounded px-2 py-1 text-sm font-semibold {current === 'members'
					? 'bg-selected text-header'
					: 'text-interactive hover:bg-hovered hover:text-normal'}">Members</button
			>
		{/if}
		<button
			role="tab"
			aria-selected={current === 'activity'}
			onclick={() => (tab = 'activity')}
			class="rounded px-2 py-1 text-sm font-semibold {current === 'activity'
				? 'bg-selected text-header'
				: 'text-interactive hover:bg-hovered hover:text-normal'}">Activity</button
		>
	</div>
	<div role="tabpanel" class="min-h-0 flex-1 overflow-y-auto py-2 scroll-thin">
		{#if current === 'members'}
			<MembersPanel {spaceId} />
		{:else}
			<ActivityPanel />
		{/if}
	</div>
</aside>
