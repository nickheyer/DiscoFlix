import { ChannelKind, type Channel } from '#lib/gen/discoflix/timeline/v1/timeline_pb';

export interface ChannelNode {
	channel: Channel;
	threads: Channel[];
}

export interface CategoryNode {
	category: Channel | null;
	channels: ChannelNode[];
}

const byPosition = (a: Channel, b: Channel) => a.position - b.position || a.name.localeCompare(b.name);

// Groups channels under their categories and threads under their parent channel
export function channelTree(channels: readonly Channel[]): CategoryNode[] {
	const categories = channels.filter((c) => c.kind === ChannelKind.CATEGORY).sort(byPosition);
	const categoryIds = new Set(categories.map((c) => c.id));
	const leaves = channels.filter((c) => c.kind !== ChannelKind.CATEGORY && c.kind !== ChannelKind.THREAD);
	const leafIds = new Set(leaves.map((c) => c.id));
	const threads = channels.filter((c) => c.kind === ChannelKind.THREAD);
	const node = (channel: Channel): ChannelNode => ({
		channel,
		threads: threads.filter((t) => t.parentId === channel.id).sort(byPosition)
	});
	const orphans = threads.filter((t) => !leafIds.has(t.parentId));
	const loose = [...leaves.filter((c) => !categoryIds.has(c.parentId)), ...orphans].sort(byPosition);
	const groups: CategoryNode[] = loose.length ? [{ category: null, channels: loose.map(node) }] : [];
	for (const category of categories) {
		groups.push({
			category,
			channels: leaves
				.filter((c) => c.parentId === category.id)
				.sort(byPosition)
				.map(node)
		});
	}
	return groups;
}

// Picks the channel a space opens on, preferring the remembered one
export function defaultChannel(channels: readonly Channel[], remembered: string | null): Channel | undefined {
	const openable = channels.filter((c) => c.kind !== ChannelKind.CATEGORY);
	return (
		openable.find((c) => c.id === remembered) ??
		channelTree(channels)
			.flatMap((g) => g.channels.map((n) => n.channel))
			.find((c) => c.kind === ChannelKind.TEXT) ??
		openable[0]
	);
}
