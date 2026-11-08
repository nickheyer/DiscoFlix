<script lang="ts">
	import '../app.css';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { onMount } from 'svelte';
	import { registerSW } from 'virtual:pwa-register';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { queryClient } from '#lib/api/query';
	import { registerBuiltinCards } from '#lib/cards/builtin';
	import { redirectFor } from '#lib/identity/routing';
	import { session } from '#lib/identity/session.svelte';
	import Splash from '#lib/identity/Splash.svelte';
	import { mobile, trackViewport } from '#lib/theme/viewport.svelte';
	import * as Tooltip from '#lib/ui/tooltip';

	let { children } = $props();

	registerBuiltinCards();

	const target = $derived(redirectFor(session.status, page.url, session.rememberPath));

	$effect(() => trackViewport());

	onMount(() => {
		void session.load();
		registerSW({ immediate: true });
	});

	$effect(() => {
		if (target !== null) void goto(target, { replaceState: true });
	});
</script>

<svelte:head>
	<title>{session.info?.instanceName || 'DiscoFlix'}</title>
</svelte:head>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider delayDuration={300} disabled={mobile.current}>
		{#if session.status === 'loading' || session.status === 'error' || target !== null}
			<Splash />
		{:else}
			{@render children()}
		{/if}
	</Tooltip.Provider>
</QueryClientProvider>
