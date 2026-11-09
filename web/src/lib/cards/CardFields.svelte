<script lang="ts" module>
	export interface CardField {
		label: string;
		value: string;
		mono?: boolean;
		wide?: boolean;
		href?: string;
	}
</script>

<script lang="ts">
	let { fields }: { fields: CardField[] } = $props();

	const shown = $derived(fields.filter((f) => f.value !== ''));
</script>

<dl class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
	{#each shown as field (field.label)}
		<div class={field.wide ? 'col-span-full' : ''}>
			<dt class="text-xs font-semibold text-interactive">{field.label}</dt>
			<dd class="break-all {field.mono ? 'font-mono text-xs' : 'text-sm'}">
				{#if field.href}
					<a href={field.href} target="_blank" rel="noreferrer" class="text-link underline">{field.value}</a>
				{:else}
					{field.value}
				{/if}
			</dd>
		</div>
	{/each}
</dl>
