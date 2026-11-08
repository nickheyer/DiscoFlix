import { equals } from '@bufbuild/protobuf';
import type { Timestamp } from '@bufbuild/protobuf/wkt';
import {
	EventKind,
	MessageSchema,
	type Channel,
	type Event,
	type Message,
	type Space
} from '#lib/gen/discoflix/timeline/v1/timeline_pb';

export const ACTIVITY_LIMIT = 50;

export interface ChannelCounter {
	spaceId: string;
	lastSeq: bigint;
	lastReadSeq: bigint;
	unread: bigint;
	known: boolean;
}

export interface ChannelMessages {
	items: readonly Message[];
	hasOlder: boolean;
}

export interface TimelineState {
	spaces: ReadonlyMap<string, bigint>;
	channels: ReadonlyMap<string, ChannelCounter>;
	messages: ReadonlyMap<string, ChannelMessages>;
	activity: readonly Message[];
	stale: ReadonlySet<string>;
}

export interface ReduceContext {
	selfId: string;
	readingChannelId: string | null;
}

export function emptyTimeline(): TimelineState {
	return { spaces: new Map(), channels: new Map(), messages: new Map(), activity: [], stale: new Set() };
}

function withEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
	const next = new Map(map);
	next.set(key, value);
	return next;
}

function bumpSpace(spaces: ReadonlyMap<string, bigint>, spaceId: string, delta: bigint): ReadonlyMap<string, bigint> {
	if (delta === 0n) return spaces;
	const value = (spaces.get(spaceId) ?? 0n) + delta;
	return withEntry(spaces, spaceId, value < 0n ? 0n : value);
}

function indexOfSeq(items: readonly Message[], seq: bigint): number {
	let lo = 0;
	let hi = items.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const at = items[mid].seq;
		if (at === seq) return mid;
		if (at < seq) lo = mid + 1;
		else hi = mid - 1;
	}
	return -lo - 1;
}

// Inserts a message in seq order and ignores a seq that is already present
export function insertMessage(items: readonly Message[], message: Message): readonly Message[] {
	const last = items[items.length - 1];
	if (!last || last.seq < message.seq) return [...items, message];
	const at = indexOfSeq(items, message.seq);
	if (at >= 0) return items;
	const next = items.slice();
	next.splice(-at - 1, 0, message);
	return next;
}

function replaceMessage(items: readonly Message[], seq: bigint, update: (old: Message) => Message): readonly Message[] {
	const at = indexOfSeq(items, seq);
	if (at < 0) return items;
	const next = items.slice();
	next[at] = update(items[at]);
	return next;
}

function tombstone(old: Message, deletedAt: Timestamp | undefined): Message {
	return { ...old, content: '', card: undefined, deletedAt: deletedAt ?? old.deletedAt };
}

function updateChannelMessages(
	state: TimelineState,
	channelId: string,
	update: (items: readonly Message[]) => readonly Message[]
): TimelineState {
	const current = state.messages.get(channelId);
	if (!current) return state;
	const items = update(current.items);
	if (items === current.items) return state;
	return { ...state, messages: withEntry(state.messages, channelId, { ...current, items }) };
}

function upsertActivity(activity: readonly Message[], message: Message, moveToTop: boolean): readonly Message[] {
	const at = activity.findIndex((m) => m.seq === message.seq);
	if (at >= 0 && !moveToTop) {
		const next = activity.slice();
		next[at] = message;
		return next;
	}
	const rest = at >= 0 ? activity.filter((_, i) => i !== at) : activity;
	const newer = rest.findIndex((m) => m.seq < message.seq);
	const next = rest.slice();
	if (moveToTop || newer < 0) {
		if (moveToTop) next.unshift(message);
		else next.push(message);
	} else {
		next.splice(newer, 0, message);
	}
	return next.slice(0, ACTIVITY_LIMIT);
}

function removeActivity(activity: readonly Message[], seq: bigint): readonly Message[] {
	return activity.some((m) => m.seq === seq) ? activity.filter((m) => m.seq !== seq) : activity;
}

function created(state: TimelineState, event: Event, message: Message, ctx: ReduceContext): TimelineState {
	const channelId = message.channelId || event.channelId;
	const spaceId = message.spaceId || event.spaceId;
	let next = updateChannelMessages(state, channelId, (items) => insertMessage(items, message));
	if (message.card) next = { ...next, activity: upsertActivity(next.activity, message, false) };
	const counter = next.channels.get(channelId);
	if (counter && counter.lastSeq >= message.seq) return next;
	const counts = message.author?.id !== ctx.selfId && channelId !== ctx.readingChannelId;
	const unread = (counter?.unread ?? 0n) + (counts ? 1n : 0n);
	const known = counter?.known ?? false;
	const lastReadSeq = counter?.lastReadSeq ?? 0n;
	return {
		...next,
		channels: withEntry(next.channels, channelId, { spaceId, lastSeq: message.seq, lastReadSeq, unread, known }),
		spaces: bumpSpace(next.spaces, spaceId, counts ? 1n : 0n)
	};
}

function read(state: TimelineState, event: Event): TimelineState {
	const counter = state.channels.get(event.channelId);
	const spaceId = counter?.spaceId ?? event.spaceId;
	if (!counter) return { ...state, stale: new Set(state.stale).add(spaceId) };
	if (event.seq <= counter.lastReadSeq && counter.known) return state;
	const caughtUp = event.seq >= counter.lastSeq;
	const nextCounter: ChannelCounter = {
		...counter,
		lastReadSeq: event.seq > counter.lastReadSeq ? event.seq : counter.lastReadSeq,
		unread: caughtUp ? 0n : counter.unread
	};
	return {
		...state,
		channels: withEntry(state.channels, event.channelId, nextCounter),
		spaces: bumpSpace(state.spaces, spaceId, caughtUp ? -counter.unread : 0n),
		stale: caughtUp && counter.known ? state.stale : new Set(state.stale).add(spaceId)
	};
}

// Applies one timeline event to the client state without mutating the previous state
export function reduceEvent(state: TimelineState, event: Event, ctx: ReduceContext): TimelineState {
	const message = event.message;
	switch (event.kind) {
		case EventKind.MESSAGE_CREATED:
			return message ? created(state, event, message, ctx) : state;
		case EventKind.MESSAGE_EDITED: {
			if (!message) return state;
			const next = updateChannelMessages(state, message.channelId || event.channelId, (items) =>
				replaceMessage(items, message.seq, (old) => ({ ...message, author: message.author ?? old.author }))
			);
			const inActivity = next.activity.some((m) => m.seq === message.seq);
			return inActivity ? { ...next, activity: upsertActivity(next.activity, message, false) } : next;
		}
		case EventKind.MESSAGE_DELETED: {
			if (!message) return state;
			const deletedAt = message.deletedAt ?? event.at;
			const next = updateChannelMessages(state, message.channelId || event.channelId, (items) =>
				replaceMessage(items, message.seq, (old) => tombstone(old, deletedAt))
			);
			const activity = removeActivity(next.activity, message.seq);
			return activity === next.activity ? next : { ...next, activity };
		}
		case EventKind.CARD_UPDATED: {
			if (!message) return state;
			const channelId = message.channelId || event.channelId;
			const next = updateChannelMessages(state, channelId, (items) =>
				replaceMessage(items, message.seq, (old) => ({ ...old, card: message.card }))
			);
			if (!message.card) return next;
			const loaded = next.messages.get(channelId)?.items ?? [];
			const at = indexOfSeq(loaded, message.seq);
			const known = at >= 0 ? loaded[at] : next.activity.find((m) => m.seq === message.seq);
			const full = known ? { ...known, card: message.card } : message;
			return { ...next, activity: upsertActivity(next.activity, full, true) };
		}
		case EventKind.CHANNEL_READ:
			return read(state, event);
		default:
			return state;
	}
}

// Replaces space unread counts with a server snapshot
export function seedSpaces(state: TimelineState, spaces: readonly Space[]): TimelineState {
	return { ...state, spaces: new Map(spaces.map((s) => [s.id, s.unread])) };
}

// Replaces channel counters of one space with a server snapshot unless a newer event was seen
export function seedChannels(state: TimelineState, spaceId: string, channels: readonly Channel[]): TimelineState {
	const next = new Map(state.channels);
	for (const [id, counter] of state.channels) {
		if (counter.spaceId === spaceId && !channels.some((c) => c.id === id)) next.delete(id);
	}
	let total = 0n;
	for (const channel of channels) {
		const current = state.channels.get(channel.id);
		const counter: ChannelCounter =
			current && current.lastSeq > channel.lastSeq
				? { ...current, known: true }
				: {
						spaceId,
						lastSeq: channel.lastSeq,
						lastReadSeq: channel.lastReadSeq,
						unread: channel.unread,
						known: true
					};
		next.set(channel.id, counter);
		total += counter.unread;
	}
	const stale = new Set(state.stale);
	stale.delete(spaceId);
	return { ...state, channels: next, spaces: withEntry(state.spaces, spaceId, total), stale };
}

// Applies a MarkRead response, which carries the authoritative counter for one channel
export function seedChannel(state: TimelineState, channel: Channel): TimelineState {
	const current = state.channels.get(channel.id);
	const spaceId = channel.spaceId || current?.spaceId || '';
	const lastSeq = current && current.lastSeq > channel.lastSeq ? current.lastSeq : channel.lastSeq;
	const counter: ChannelCounter = {
		spaceId,
		lastSeq,
		lastReadSeq: channel.lastReadSeq,
		unread: lastSeq > channel.lastSeq && current ? current.unread : channel.unread,
		known: true
	};
	return {
		...state,
		channels: withEntry(state.channels, channel.id, counter),
		spaces: bumpSpace(state.spaces, spaceId, counter.unread - (current?.unread ?? 0n))
	};
}

// Starts tracking messages for a channel so live events are kept while the first page loads
export function openChannel(state: TimelineState, channelId: string): TimelineState {
	if (state.messages.has(channelId)) return state;
	return { ...state, messages: withEntry(state.messages, channelId, { items: [], hasOlder: true }) };
}

// Inserts or replaces each message by seq so changed server copies win over cached ones
function upsertAll(items: readonly Message[], page: readonly Message[]): readonly Message[] {
	let next = items;
	for (const message of page) {
		const at = indexOfSeq(next, message.seq);
		if (at < 0) {
			next = insertMessage(next, message);
		} else if (!equals(MessageSchema, next[at], message)) {
			const copy = next.slice();
			copy[at] = message;
			next = copy;
		}
	}
	return next;
}

// Merges the newest page, dropping cached history when the page does not reach it
export function mergeLatest(
	state: TimelineState,
	channelId: string,
	page: readonly Message[],
	hasMore: boolean
): TimelineState {
	const ascending = [...page].sort((x, y) => (x.seq < y.seq ? -1 : x.seq > y.seq ? 1 : 0));
	const current = state.messages.get(channelId);
	const cached = current?.items ?? [];
	const oldestFetched = ascending[0]?.seq;
	const newestFetched = ascending[ascending.length - 1]?.seq;
	const newestCached = cached[cached.length - 1]?.seq;
	const fresh = newestFetched === undefined ? cached : cached.filter((m) => m.seq > newestFetched);
	const gap = hasMore && oldestFetched !== undefined && newestCached !== undefined && oldestFetched > newestCached;
	const restart = gap || fresh.length === cached.length;
	const items = restart ? upsertAll(ascending, fresh) : upsertAll(cached, ascending);
	const hasOlder = restart ? hasMore : (current?.hasOlder ?? hasMore);
	if (current && items === current.items && hasOlder === current.hasOlder) return state;
	return { ...state, messages: withEntry(state.messages, channelId, { items, hasOlder }) };
}

// Prepends an older page fetched with before_seq
export function mergeOlder(
	state: TimelineState,
	channelId: string,
	page: readonly Message[],
	hasMore: boolean
): TimelineState {
	const current = state.messages.get(channelId);
	if (!current) return state;
	return {
		...state,
		messages: withEntry(state.messages, channelId, { items: upsertAll(current.items, page), hasOlder: hasMore })
	};
}

// Appends history after live entries skipping known messages, or replaces the list after a stream gap
export function mergeActivity(state: TimelineState, newestFirst: readonly Message[], replace: boolean): TimelineState {
	if (replace) return { ...state, activity: newestFirst.filter((m) => m.card).slice(0, ACTIVITY_LIMIT) };
	const listed = new Set(state.activity.map((m) => m.seq));
	const extra = newestFirst.filter((m) => m.card && !listed.has(m.seq));
	if (extra.length === 0) return state;
	return { ...state, activity: [...state.activity, ...extra].slice(0, ACTIVITY_LIMIT) };
}

export function clearStale(state: TimelineState): TimelineState {
	return state.stale.size === 0 ? state : { ...state, stale: new Set() };
}
