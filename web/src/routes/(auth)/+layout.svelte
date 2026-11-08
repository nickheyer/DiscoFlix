<script lang="ts">
	import Mark from '#lib/theme/Mark.svelte';

	let { children } = $props();
</script>

<main
	class="flex app-height items-center justify-center overflow-y-auto bg-[radial-gradient(circle_at_top,#4e5d94_0%,#2c2f33_55%,#202225_100%)] p-0 sm:p-6"
>
	<div class="w-full max-w-[480px] bg-chat p-6 shadow-2xl sm:rounded-lg sm:p-8">
		<div class="mb-6 flex justify-center">
			<Mark size={56} />
		</div>
		{@render children()}
	</div>
</main>
