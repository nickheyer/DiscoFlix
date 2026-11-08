<script lang="ts">
	import ImageOff from '@lucide/svelte/icons/image-off';
	import type { ArtworkVariant } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
	import { cn } from '#lib/ui/utils';
	import { srcsetFor, variantFormats } from './artwork';
	import { thumbhashDataUrl } from './thumbhash';

	let {
		src,
		thumbhash,
		alt,
		variants = [],
		sizes = '',
		ratio = '',
		class: className = ''
	}: {
		src: string;
		thumbhash: string;
		alt: string;
		variants?: ArtworkVariant[];
		sizes?: string;
		ratio?: string;
		class?: string;
	} = $props();

	const placeholder = $derived(thumbhashDataUrl(thumbhash));
	const formats = $derived(variantFormats(variants));
	let loadedSrc = $state('');
	let failedSrc = $state('');
	const loaded = $derived(src !== '' && loadedSrc === src);
	const failed = $derived(src !== '' && failedSrc === src);
</script>

<div class={cn('relative overflow-hidden bg-tertiary', className)} style:aspect-ratio={ratio || undefined}>
	{#if placeholder && !loaded}
		<img src={placeholder} alt="" aria-hidden="true" class="absolute inset-0 size-full object-cover" />
	{/if}
	{#if src && !failed}
		{#key src}
			<picture>
				{#each formats as format (format)}
					<source type="image/{format}" srcset={srcsetFor(variants, format)} sizes={sizes || undefined} />
				{/each}
				<img
					{src}
					{alt}
					loading="lazy"
					decoding="async"
					onload={() => (loadedSrc = src)}
					onerror={() => (failedSrc = src)}
					class="absolute inset-0 size-full object-cover transition-opacity duration-300 {loaded
						? 'opacity-100'
						: 'opacity-0'}"
				/>
			</picture>
		{/key}
	{/if}
	{#if !placeholder && (!src || failed)}
		<div class="absolute inset-0 flex items-center justify-center text-faint" aria-hidden="true">
			<ImageOff class="size-1/3 max-h-10 max-w-10" />
		</div>
	{/if}
</div>
