import { create } from '@bufbuild/protobuf';
import { anyPack, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { SystemNoticeSchema } from '#lib/gen/discoflix/card/v1/system_pb';
import {
	AuthorSchema,
	ChannelSchema,
	EventKind,
	EventSchema,
	MessageSchema,
	SpaceSchema,
	type Event,
	type Message
} from '#lib/gen/discoflix/timeline/v1/timeline_pb';
import {
	emptyTimeline,
	mergeActivity,
	mergeLatest,
	mergeOlder,
	openChannel,
	reduceEvent,
	seedChannel,
	seedChannels,
	seedSpaces,
	type ReduceContext,
	type TimelineState
} from './reducer';

const SPACE = 'space-1';
const CHANNEL = 'chan-1';
const OTHER = 'chan-2';
const ctx: ReduceContext = { selfId: 'me', readingChannelId: null };

function msg(seq: number, init: Partial<Omit<Message, '$typeName'>> = {}): Message {
	const base = create(MessageSchema, {
		seq: BigInt(seq),
		spaceId: SPACE,
		channelId: CHANNEL,
		author: create(AuthorSchema, { id: 'alice', displayName: 'Alice', kind: 'person' }),
		content: `message ${seq}`,
		createdAt: timestampFromDate(new Date(Date.UTC(2026, 10, 8, 12, 0, seq)))
	});
	return { ...base, ...init };
}

function event(kind: EventKind, message: Message, seq = message.seq): Event {
	return create(EventSchema, { seq, kind, message, channelId: message.channelId, spaceId: message.spaceId });
}

function notice(title: string) {
	return anyPack(SystemNoticeSchema, create(SystemNoticeSchema, { title }));
}

function seeded(): TimelineState {
	let state = seedSpaces(emptyTimeline(), [create(SpaceSchema, { id: SPACE, unread: 0n })]);
	state = seedChannels(state, SPACE, [
		create(ChannelSchema, { id: CHANNEL, spaceId: SPACE, lastSeq: 10n, lastReadSeq: 10n, unread: 0n }),
		create(ChannelSchema, { id: OTHER, spaceId: SPACE, lastSeq: 5n, lastReadSeq: 3n, unread: 2n })
	]);
	return openChannel(state, CHANNEL);
}

const seqs = (state: TimelineState, channel = CHANNEL) =>
	state.messages.get(channel)?.items.map((m) => Number(m.seq)) ?? [];

describe('reduceEvent', () => {
	it('appends created messages in seq order and ignores duplicates', () => {
		let state = seeded();
		state = reduceEvent(state, event(EventKind.MESSAGE_CREATED, msg(12)), ctx);
		state = reduceEvent(state, event(EventKind.MESSAGE_CREATED, msg(11)), ctx);
		state = reduceEvent(state, event(EventKind.MESSAGE_CREATED, msg(12)), ctx);
		expect(seqs(state)).toEqual([11, 12]);
	});

	it('counts unread for other authors once per seq and updates the space total', () => {
		let state = seeded();
		state = reduceEvent(state, event(EventKind.MESSAGE_CREATED, msg(11)), ctx);
		state = reduceEvent(state, event(EventKind.MESSAGE_CREATED, msg(11)), ctx);
		expect(state.channels.get(CHANNEL)?.unread).toBe(1n);
		expect(state.channels.get(CHANNEL)?.lastSeq).toBe(11n);
		expect(state.spaces.get(SPACE)).toBe(3n);
	});

	it('does not count own messages or messages in the channel being read', () => {
		let state = seeded();
		state = reduceEvent(
			state,
			event(EventKind.MESSAGE_CREATED, msg(11, { author: create(AuthorSchema, { id: 'me' }) })),
			ctx
		);
		state = reduceEvent(state, event(EventKind.MESSAGE_CREATED, msg(12)), { ...ctx, readingChannelId: CHANNEL });
		expect(state.channels.get(CHANNEL)?.unread).toBe(0n);
		expect(state.spaces.get(SPACE)).toBe(2n);
	});

	it('tracks counters for channels the client has not loaded', () => {
		const state = reduceEvent(emptyTimeline(), event(EventKind.MESSAGE_CREATED, msg(4, { channelId: 'x' })), ctx);
		expect(state.channels.get('x')).toMatchObject({ unread: 1n, known: false, lastSeq: 4n });
		expect(state.spaces.get(SPACE)).toBe(1n);
		expect(state.messages.has('x')).toBe(false);
	});

	it('replaces edited messages by seq and keeps the author when the event omits it', () => {
		let state = reduceEvent(seeded(), event(EventKind.MESSAGE_CREATED, msg(11)), ctx);
		const edit = msg(11, { content: 'edited', author: undefined, editedAt: timestampFromDate(new Date()) });
		state = reduceEvent(state, event(EventKind.MESSAGE_EDITED, edit, 20n), ctx);
		const item = state.messages.get(CHANNEL)?.items[0];
		expect(item?.content).toBe('edited');
		expect(item?.editedAt).toBeDefined();
		expect(item?.author?.id).toBe('alice');
	});

	it('marks deleted messages as tombstones without removing them', () => {
		let state = reduceEvent(seeded(), event(EventKind.MESSAGE_CREATED, msg(11, { card: notice('x') })), ctx);
		const deletedAt = timestampFromDate(new Date());
		state = reduceEvent(state, event(EventKind.MESSAGE_DELETED, msg(11, { deletedAt }), 21n), ctx);
		const item = state.messages.get(CHANNEL)?.items[0];
		expect(seqs(state)).toEqual([11]);
		expect(item?.deletedAt).toEqual(deletedAt);
		expect(item?.content).toBe('');
		expect(item?.card).toBeUndefined();
		expect(state.activity).toEqual([]);
	});

	it('replaces the card by seq and moves it to the top of recent activity', () => {
		let state = seeded();
		state = reduceEvent(state, event(EventKind.MESSAGE_CREATED, msg(11, { card: notice('first') })), ctx);
		state = reduceEvent(state, event(EventKind.MESSAGE_CREATED, msg(12, { card: notice('second') })), ctx);
		expect(state.activity.map((m) => Number(m.seq))).toEqual([12, 11]);
		const update = create(MessageSchema, { seq: 11n, channelId: CHANNEL, spaceId: SPACE, card: notice('updated') });
		state = reduceEvent(state, event(EventKind.CARD_UPDATED, update, 30n), ctx);
		const item = state.messages.get(CHANNEL)?.items[0];
		expect(item?.card).toEqual(notice('updated'));
		expect(item?.content).toBe('message 11');
		expect(state.activity.map((m) => Number(m.seq))).toEqual([11, 12]);
		expect(state.activity[0].author?.id).toBe('alice');
	});

	it('clears unread on a channel read that reaches the newest seq', () => {
		let state = reduceEvent(seeded(), event(EventKind.MESSAGE_CREATED, msg(11)), ctx);
		const read = create(EventSchema, { kind: EventKind.CHANNEL_READ, seq: 11n, channelId: CHANNEL, spaceId: SPACE });
		state = reduceEvent(state, read, ctx);
		expect(state.channels.get(CHANNEL)).toMatchObject({ unread: 0n, lastReadSeq: 11n });
		expect(state.spaces.get(SPACE)).toBe(2n);
		expect(state.stale.size).toBe(0);
	});

	it('marks the space stale when a read stops short of the newest seq', () => {
		const read = create(EventSchema, { kind: EventKind.CHANNEL_READ, seq: 4n, channelId: OTHER, spaceId: SPACE });
		const state = reduceEvent(seeded(), read, ctx);
		expect(state.channels.get(OTHER)).toMatchObject({ unread: 2n, lastReadSeq: 4n });
		expect([...state.stale]).toEqual([SPACE]);
	});

	it('ignores events it does not understand', () => {
		const state = seeded();
		expect(reduceEvent(state, create(EventSchema, { kind: EventKind.UNSPECIFIED }), ctx)).toBe(state);
	});
});

describe('seeding and paging', () => {
	it('keeps a counter that saw a newer event than the snapshot', () => {
		let state = reduceEvent(seeded(), event(EventKind.MESSAGE_CREATED, msg(11)), ctx);
		state = seedChannels(state, SPACE, [
			create(ChannelSchema, { id: CHANNEL, spaceId: SPACE, lastSeq: 10n, lastReadSeq: 10n, unread: 0n })
		]);
		expect(state.channels.get(CHANNEL)?.unread).toBe(1n);
		expect(state.channels.has(OTHER)).toBe(false);
		expect(state.spaces.get(SPACE)).toBe(1n);
	});

	it('applies a MarkRead response to the channel and space', () => {
		const state = seedChannel(
			seeded(),
			create(ChannelSchema, { id: OTHER, spaceId: SPACE, lastSeq: 5n, lastReadSeq: 5n, unread: 0n })
		);
		expect(state.channels.get(OTHER)?.unread).toBe(0n);
		expect(state.spaces.get(SPACE)).toBe(0n);
	});

	it('merges the newest page with live messages that arrived while it loaded', () => {
		let state = reduceEvent(seeded(), event(EventKind.MESSAGE_CREATED, msg(13)), ctx);
		state = mergeLatest(state, CHANNEL, [msg(12), msg(11)], true);
		expect(seqs(state)).toEqual([11, 12, 13]);
		expect(state.messages.get(CHANNEL)?.hasOlder).toBe(true);
	});

	it('drops cached history when the newest page does not reach it', () => {
		let state = mergeLatest(seeded(), CHANNEL, [msg(2), msg(1)], false);
		state = mergeLatest(state, CHANNEL, [msg(40), msg(39)], true);
		expect(seqs(state)).toEqual([39, 40]);
		expect(state.messages.get(CHANNEL)?.hasOlder).toBe(true);
	});

	it('prefers the server copy when a reload overlaps the cache', () => {
		let state = mergeLatest(seeded(), CHANNEL, [msg(2), msg(1)], false);
		state = mergeLatest(state, CHANNEL, [msg(2, { content: 'fresh' }), msg(1)], false);
		expect(state.messages.get(CHANNEL)?.items[1].content).toBe('fresh');
	});

	it('keeps the state untouched when a reload returns identical messages', () => {
		const state = mergeLatest(seeded(), CHANNEL, [msg(2), msg(1)], false);
		expect(mergeLatest(state, CHANNEL, [msg(2), msg(1)], false)).toBe(state);
	});

	it('prepends older pages', () => {
		let state = mergeLatest(seeded(), CHANNEL, [msg(10), msg(9)], true);
		state = mergeOlder(state, CHANNEL, [msg(8), msg(7)], false);
		expect(seqs(state)).toEqual([7, 8, 9, 10]);
		expect(state.messages.get(CHANNEL)?.hasOlder).toBe(false);
	});

	it('appends history activity after live entries without duplicates', () => {
		let state = reduceEvent(seeded(), event(EventKind.MESSAGE_CREATED, msg(20, { card: notice('live') })), ctx);
		state = mergeActivity(state, [msg(20, { card: notice('old') }), msg(5, { card: notice('older') }), msg(4)], false);
		expect(state.activity.map((m) => Number(m.seq))).toEqual([20, 5]);
	});

	it('replaces activity with history after an unrecovered gap', () => {
		let state = reduceEvent(seeded(), event(EventKind.MESSAGE_CREATED, msg(20, { card: notice('live') })), ctx);
		state = mergeActivity(state, [msg(30, { card: notice('newer') }), msg(4)], true);
		expect(state.activity.map((m) => Number(m.seq))).toEqual([30]);
	});
});
