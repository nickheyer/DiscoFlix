<script lang="ts">
	import KeyRound from '@lucide/svelte/icons/key-round';
	import { onMount } from 'svelte';
	import { identityClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import { session } from '#lib/identity/session.svelte';
	import { conditionalAvailable, getPasskey, passkeysSupported } from '#lib/identity/webauthn';
	import { Button } from '#lib/ui/button';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';

	let username = $state('');
	let password = $state('');
	let busy = $state<'password' | 'passkey' | null>(null);
	let error = $state('');
	let conditional: AbortController | null = null;

	const info = $derived(session.info);
	const passwordEnabled = $derived(info?.passwordLogin ?? false);
	const passkeyEnabled = $derived((info?.passkeyLogin ?? false) && passkeysSupported());

	async function finish(): Promise<void> {
		conditional?.abort();
		await session.signedIn();
	}

	async function signInWithPassword(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		busy = 'password';
		error = '';
		try {
			await identityClient.loginWithPassword({ username: username.trim(), password });
			await finish();
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = null;
		}
	}

	// Runs one passkey ceremony, modal when the button is used and inline autofill otherwise
	async function passkeyCeremony(mediation: CredentialMediationRequirement, signal: AbortSignal): Promise<void> {
		const begin = await identityClient.beginPasskeyLogin({});
		const credentialJson = await getPasskey(begin.optionsJson, mediation, signal);
		if (!credentialJson) return;
		busy = 'passkey';
		await identityClient.finishPasskeyLogin({ ceremony: begin.ceremony, credentialJson });
		await finish();
	}

	async function signInWithPasskey(): Promise<void> {
		conditional?.abort();
		conditional = null;
		busy = 'passkey';
		error = '';
		try {
			await passkeyCeremony('optional', new AbortController().signal);
		} catch (err) {
			error =
				err instanceof DOMException && err.name === 'NotAllowedError'
					? 'Passkey sign-in was cancelled'
					: errorText(err);
		} finally {
			busy = null;
		}
	}

	onMount(() => {
		if (!passkeyEnabled) return;
		const controller = new AbortController();
		conditional = controller;
		void conditionalAvailable().then(async (available) => {
			if (!available || controller.signal.aborted) return;
			try {
				await passkeyCeremony('conditional', controller.signal);
			} catch (err) {
				if (!controller.signal.aborted && !(err instanceof DOMException && err.name === 'AbortError')) {
					error = errorText(err);
					busy = null;
				}
			}
		});
		return () => controller.abort();
	});
</script>

<h1 class="text-center text-2xl font-semibold text-header">Welcome back!</h1>
<p class="mt-1 text-center text-interactive">Sign in to {info?.instanceName || 'DiscoFlix'}</p>

{#if passwordEnabled}
	<form class="mt-6 space-y-4" onsubmit={signInWithPassword}>
		<div class="space-y-2">
			<Label for="username" class="text-xs font-bold tracking-wide text-interactive uppercase">Username</Label>
			<Input
				id="username"
				bind:value={username}
				autocomplete="username webauthn"
				autocapitalize="none"
				spellcheck={false}
				required
				maxlength={32}
				class="h-10 border-0 bg-tertiary"
			/>
		</div>
		<div class="space-y-2">
			<Label for="password" class="text-xs font-bold tracking-wide text-interactive uppercase">Password</Label>
			<Input
				id="password"
				type="password"
				bind:value={password}
				autocomplete="current-password"
				required
				maxlength={256}
				class="h-10 border-0 bg-tertiary"
			/>
		</div>
		<Button type="submit" class="h-11 w-full text-base" disabled={busy !== null}>
			{busy === 'password' ? 'Signing in' : 'Sign in'}
		</Button>
	</form>
{:else if passkeyEnabled}
	<input class="sr-only" aria-label="Username" autocomplete="username webauthn" tabindex="-1" />
{/if}

{#if passkeyEnabled}
	{#if passwordEnabled}
		<div class="my-4 flex items-center gap-3 text-xs text-faint uppercase">
			<span class="h-px flex-1 bg-divider"></span>or<span class="h-px flex-1 bg-divider"></span>
		</div>
	{/if}
	<Button
		variant="secondary"
		class="h-11 w-full text-base {passwordEnabled ? '' : 'mt-6'}"
		disabled={busy !== null}
		onclick={signInWithPasskey}
	>
		<KeyRound class="size-5" />
		{busy === 'passkey' ? 'Waiting for passkey' : 'Sign in with a passkey'}
	</Button>
{/if}

{#if !passwordEnabled && !passkeyEnabled}
	<p class="mt-6 rounded bg-dnd/15 p-3 text-sm text-dnd" role="alert">
		{info?.passkeyLogin
			? 'This server only accepts passkeys and this browser cannot use them'
			: 'This server has no sign-in method enabled'}
	</p>
{/if}

{#if error}
	<p class="mt-4 text-sm text-dnd" role="alert">{error}</p>
{/if}
