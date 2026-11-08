<script lang="ts" module>
	export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
</script>

<script lang="ts">
	import * as Avatar from '#lib/ui/avatar';
	import { avatarColor, initials } from '#lib/theme/identity-colors';

	let {
		id,
		name,
		src = '',
		accent = '',
		size = 40,
		presence,
		ring = 'border-sidebar'
	}: {
		id: string;
		name: string;
		src?: string;
		accent?: string;
		size?: number;
		presence?: Presence;
		ring?: string;
	} = $props();

	const dots: Record<Presence, string> = {
		online: 'bg-online',
		idle: 'bg-idle',
		dnd: 'bg-dnd',
		offline: 'bg-faint'
	};
</script>

<span class="relative inline-flex shrink-0" style:width="{size}px" style:height="{size}px">
	<Avatar.Root class="size-full after:hidden">
		{#if src}
			<Avatar.Image {src} alt="" />
		{/if}
		<Avatar.Fallback
			class="font-semibold text-white"
			style="background-color: {avatarColor(id, accent)}; font-size: {Math.round(size * 0.36)}px"
		>
			{initials(name)}
		</Avatar.Fallback>
	</Avatar.Root>
	{#if presence}
		<span
			class="absolute -right-0.5 -bottom-0.5 rounded-full border-[3px] {ring} {dots[presence]}"
			style:width="{Math.max(10, Math.round(size * 0.4))}px"
			style:height="{Math.max(10, Math.round(size * 0.4))}px"
		></span>
	{/if}
</span>
