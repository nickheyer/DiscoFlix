<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';

	let { name, collapsed, ontoggle }: { name: string; collapsed: boolean; ontoggle: () => void } = $props();
</script>

<button
	class="flex w-full items-center gap-0.5 px-1 pt-4 pb-1 text-xs font-semibold tracking-wide text-faint uppercase hover:text-normal"
	aria-expanded={!collapsed}
	onclick={ontoggle}
>
	<ChevronDown class="size-3 transition-transform {collapsed ? '-rotate-90' : ''}" />
	<span class="truncate">{name}</span>
</button>
