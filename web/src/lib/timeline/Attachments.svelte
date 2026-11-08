<script lang="ts">
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import type { Attachment } from '#lib/gen/discoflix/timeline/v1/timeline_pb';

	let { attachments }: { attachments: Attachment[] } = $props();

	const images = $derived(attachments.filter((a) => a.contentType.startsWith('image/')));
	const files = $derived(attachments.filter((a) => !a.contentType.startsWith('image/')));

	function size(bytes: bigint): string {
		const n = Number(bytes);
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	// Bounds an image to the message column while keeping its aspect ratio
	function dims(a: Attachment): string {
		if (!a.width || !a.height) return 'max-width: 400px; max-height: 300px';
		const scale = Math.min(1, 400 / a.width, 300 / a.height);
		return `width: ${Math.round(a.width * scale)}px; height: ${Math.round(a.height * scale)}px`;
	}
</script>

<div class="mt-1 flex flex-col gap-1">
	{#each images as image (image.id)}
		<a href={image.url} target="_blank" rel="noopener noreferrer" class="block w-fit">
			<img
				src={image.url}
				alt={image.name}
				loading="lazy"
				style={dims(image)}
				class="rounded-lg bg-tertiary object-contain"
			/>
		</a>
	{/each}
	{#each files as file (file.id)}
		<a
			href={file.url}
			target="_blank"
			rel="noopener noreferrer"
			class="flex w-fit max-w-full items-center gap-2 rounded-lg border border-tertiary bg-sidebar px-3 py-2 text-sm hover:border-hover"
		>
			<Paperclip class="size-5 shrink-0 text-interactive" />
			<span class="min-w-0">
				<span class="block truncate text-link">{file.name}</span>
				<span class="block text-xs text-faint">{size(file.size)}</span>
			</span>
		</a>
	{/each}
</div>
