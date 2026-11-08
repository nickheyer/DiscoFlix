<script lang="ts">
	import LogOut from '@lucide/svelte/icons/log-out';
	import X from '@lucide/svelte/icons/x';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { errorText } from '#lib/api/errors';
	import { session } from '#lib/identity/session.svelte';
	import { setSettingsReturn, settingsLinks, settingsReturn } from '#lib/identity/settings-nav';

	let { children } = $props();

	let signOutError = $state('');

	const links = $derived(settingsLinks.filter((l) => !l.admin || session.isAdmin));
	const userLinks = $derived(links.filter((l) => !l.admin));
	const adminLinks = $derived(links.filter((l) => l.admin));
	const current = $derived(links.find((l) => page.url.pathname.startsWith(l.href)));

	afterNavigate(({ from }) => {
		if (from) setSettingsReturn(from.url.pathname);
	});

	function close(): void {
		void goto(settingsReturn());
	}

	async function signOut(): Promise<void> {
		signOutError = '';
		try {
			await session.signOut();
		} catch (err) {
			signOutError = errorText(err);
		}
	}

	function keydown(e: KeyboardEvent): void {
		if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="alertdialog"],[role="dialog"]'))
			close();
	}
</script>

<svelte:window onkeydown={keydown} />

<svelte:head>
	<title>{current?.label ?? 'Settings'}</title>
</svelte:head>

{#snippet navLink(link: { href: string; label: string })}
	<a
		href={link.href}
		aria-current={current?.href === link.href ? 'page' : undefined}
		class="block shrink-0 rounded px-2.5 py-1.5 text-[15px] whitespace-nowrap md:mb-0.5 {current?.href === link.href
			? 'bg-selected text-header'
			: 'text-interactive hover:bg-hovered hover:text-normal'}">{link.label}</a
	>
{/snippet}

<div class="fixed inset-x-0 top-[var(--app-offset)] flex app-height flex-col bg-chat md:flex-row">
	<nav
		aria-label="Settings"
		class="flex shrink-0 items-center gap-1 overflow-x-auto bg-sidebar px-2 py-2 scroll-none md:w-[max(218px,calc((100%-740px)/2))] md:flex-col md:items-end md:overflow-y-auto md:px-2 md:py-14"
	>
		<button
			onclick={close}
			aria-label="Close settings"
			class="flex size-9 shrink-0 items-center justify-center rounded-full text-faint hover:text-normal md:hidden"
		>
			<X class="size-5" />
		</button>
		<div class="flex items-center gap-1 md:block md:w-[194px]">
			<h2 class="hidden px-2.5 pb-1.5 text-xs font-bold tracking-wide text-faint uppercase md:block">User settings</h2>
			{#each userLinks as link (link.href)}
				{@render navLink(link)}
			{/each}
			{#if adminLinks.length}
				<div class="mx-2.5 my-2 hidden h-px bg-divider md:block"></div>
				<h2 class="hidden px-2.5 pb-1.5 text-xs font-bold tracking-wide text-faint uppercase md:block">Server</h2>
				{#each adminLinks as link (link.href)}
					{@render navLink(link)}
				{/each}
			{/if}
			<div class="mx-2.5 my-2 hidden h-px bg-divider md:block"></div>
			<button
				onclick={signOut}
				class="flex w-full shrink-0 items-center justify-between gap-2 rounded px-2.5 py-1.5 text-[15px] whitespace-nowrap text-dnd hover:bg-hovered"
			>
				Sign out <LogOut class="size-4" />
			</button>
			{#if signOutError}
				<p class="px-2.5 text-xs text-dnd" role="alert">{signOutError}</p>
			{/if}
		</div>
	</nav>
	<div class="relative min-h-0 flex-1 overflow-y-auto scroll-thin">
		<div class="mx-auto max-w-[740px] px-4 pt-6 pb-20 md:px-10 md:pt-14">
			<h1 class="mb-5 text-xl font-semibold text-header">{current?.label ?? 'Settings'}</h1>
			{@render children()}
		</div>
		<button
			onclick={close}
			aria-label="Close settings"
			class="fixed top-[calc(var(--app-offset)+3.5rem)] right-8 hidden flex-col items-center gap-1 text-faint hover:text-normal md:flex"
		>
			<span class="flex size-9 items-center justify-center rounded-full border-2 border-current"
				><X class="size-5" /></span
			>
			<span class="text-xs font-semibold">ESC</span>
		</button>
	</div>
</div>
