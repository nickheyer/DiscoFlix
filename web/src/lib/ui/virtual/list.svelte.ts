import {
	elementScroll,
	observeElementOffset,
	observeElementRect,
	Virtualizer,
	type VirtualItem,
	type VirtualizerOptions
} from '@tanstack/svelte-virtual';
import { untrack } from 'svelte';

type Key = number | string | bigint;

export interface ListParams {
	count: () => number;
	scrollElement: () => HTMLElement | undefined;
	estimateSize: (index: number) => number;
	itemKey: (index: number) => Key;
}

export interface VirtualList {
	readonly items: VirtualItem[];
	readonly size: number;
	measure: (node: HTMLElement) => void;
}

// Drives a TanStack virtualizer from runes so rows re-render when the visible range changes
export function createVirtualList(params: ListParams): VirtualList {
	let version = $state(0);
	const bump = () => untrack(() => version++);
	const options = (count: number): VirtualizerOptions<HTMLElement, HTMLElement> => ({
		count,
		getScrollElement: () => params.scrollElement() ?? null,
		estimateSize: params.estimateSize,
		getItemKey: params.itemKey,
		overscan: 6,
		observeElementRect,
		observeElementOffset,
		scrollToFn: elementScroll,
		onChange: bump
	});
	const virtualizer = new Virtualizer(options(0));

	$effect(() => virtualizer._didMount());

	$effect(() => {
		const count = params.count();
		void params.scrollElement();
		untrack(() => {
			virtualizer.setOptions(options(count));
			virtualizer._willUpdate();
		});
		bump();
	});

	return {
		get items() {
			void version;
			return virtualizer.getVirtualItems();
		},
		get size() {
			void version;
			return virtualizer.getTotalSize();
		},
		measure: (node) => {
			virtualizer.measureElement(node);
		}
	};
}
