<script lang="ts">
	import { page } from '$app/state';
	import EntityView from '#lib/catalog/EntityView.svelte';

	const id = $derived(page.params.id ?? '');
</script>

{#key id}
	<EntityView {id} />
{/key}
