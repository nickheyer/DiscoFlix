<script lang="ts">
	import { formatDay } from '#lib/theme/format';

	let { date }: { date: Date } = $props();
</script>

<div role="separator" class="mx-4 mt-6 mb-2 flex items-center">
	<span class="h-px flex-1 bg-divider"></span>
	<time class="px-2 text-xs font-semibold text-faint" datetime={date.toISOString()}>{formatDay(date)}</time>
	<span class="h-px flex-1 bg-divider"></span>
</div>
