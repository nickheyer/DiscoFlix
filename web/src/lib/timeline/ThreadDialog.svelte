<script lang="ts">
	import { goto } from '$app/navigation';
	import { timelineClient } from '#lib/api/clients';
	import { errorText } from '#lib/api/errors';
	import type { Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
	import { Button } from '#lib/ui/button';
	import * as Dialog from '#lib/ui/dialog';
	import { Input } from '#lib/ui/input';
	import { Label } from '#lib/ui/label';

	let {
		open = $bindable(false),
		channelId,
		spaceId,
		from
	}: { open?: boolean; channelId: string; spaceId: string; from: Message | null } = $props();

	let name = $state('');
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		if (open) name = from?.content.split('\n')[0].slice(0, 100) ?? '';
	});

	async function create(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			const res = await timelineClient.createThread({ channelId, name: name.trim(), fromSeq: from?.seq ?? 0n });
			open = false;
			if (res.channel) await goto(`/s/${spaceId}/c/${res.channel.id}`);
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<form onsubmit={create} class="space-y-4">
			<Dialog.Header>
				<Dialog.Title>Create thread</Dialog.Title>
				<Dialog.Description>
					{from ? 'A thread that starts from the selected message.' : 'A new thread in this channel.'}
				</Dialog.Description>
			</Dialog.Header>
			<div class="space-y-2">
				<Label for="thread-name" class="text-xs font-bold tracking-wide text-interactive uppercase">Thread name</Label>
				<Input id="thread-name" bind:value={name} maxlength={100} required class="h-10 border-0 bg-tertiary" />
			</div>
			{#if error}
				<p class="text-sm text-dnd" role="alert">{error}</p>
			{/if}
			<Dialog.Footer>
				<Button type="submit" disabled={busy || name.trim() === ''}>{busy ? 'Creating' : 'Create thread'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
