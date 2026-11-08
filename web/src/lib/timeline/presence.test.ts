import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { EventKind, EventSchema, MessageSchema } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
import {
	emptyTimeline,
	expireTyping,
	mergeLatest,
	openChannel,
	reduceEvent,
	replaceLoaded,
	TYPING_TTL_MS
} from './reducer';

const ctx = { selfId: 'me', readingChannelId: null, now: 1000 };

function message(seq: bigint) {
	return create(MessageSchema, { seq, channelId: 'c1', spaceId: 's1', content: 'hi', author: { id: 'other' } });
}

function loaded() {
	return mergeLatest(openChannel(emptyTimeline(), 'c1'), 'c1', [message(1n), message(2n)], false);
}

describe('reactions', () => {
	it('applies absolute counts and tracks the caller', () => {
		let state = loaded();
		state = reduceEvent(
			state,
			create(EventSchema, {
				kind: EventKind.REACTION_ADDED,
				channelId: 'c1',
				spaceId: 's1',
				reaction: { seq: 1n, emoji: '👍', userId: 'other', count: 1n }
			}),
			ctx
		);
		expect(state.messages.get('c1')?.items[0].reactions).toEqual([
			expect.objectContaining({ emoji: '👍', count: 1n, me: false })
		]);
		state = reduceEvent(
			state,
			create(EventSchema, {
				kind: EventKind.REACTION_ADDED,
				channelId: 'c1',
				spaceId: 's1',
				reaction: { seq: 1n, emoji: '👍', userId: 'me', count: 2n }
			}),
			ctx
		);
		expect(state.messages.get('c1')?.items[0].reactions[0]).toMatchObject({ count: 2n, me: true });
		const again = reduceEvent(
			state,
			create(EventSchema, {
				kind: EventKind.REACTION_ADDED,
				channelId: 'c1',
				spaceId: 's1',
				reaction: { seq: 1n, emoji: '👍', userId: 'me', count: 2n }
			}),
			ctx
		);
		expect(again.messages.get('c1')?.items[0].reactions[0]).toMatchObject({ count: 2n, me: true });
		state = reduceEvent(
			again,
			create(EventSchema, {
				kind: EventKind.REACTION_REMOVED,
				channelId: 'c1',
				spaceId: 's1',
				reaction: { seq: 1n, emoji: '👍', userId: 'me', count: 1n }
			}),
			ctx
		);
		expect(state.messages.get('c1')?.items[0].reactions[0]).toMatchObject({ count: 1n, me: false });
		state = reduceEvent(
			state,
			create(EventSchema, {
				kind: EventKind.REACTION_REMOVED,
				channelId: 'c1',
				spaceId: 's1',
				reaction: { seq: 1n, emoji: '👍', userId: 'other', count: 0n }
			}),
			ctx
		);
		expect(state.messages.get('c1')?.items[0].reactions).toEqual([]);
	});

	it('replaces a loaded message with the server copy', () => {
		const state = loaded();
		const copy = create(MessageSchema, {
			seq: 2n,
			channelId: 'c1',
			spaceId: 's1',
			content: 'server',
			author: { id: 'other' },
			reactions: [{ emoji: '🔥', count: 1n, me: true }]
		});
		const next = replaceLoaded(state, copy);
		expect(next.messages.get('c1')?.items[1].content).toBe('server');
		expect(next.messages.get('c1')?.items[1].reactions[0].me).toBe(true);
	});
});

describe('typing and presence', () => {
	it('records who is typing and expires them', () => {
		let state = reduceEvent(
			emptyTimeline(),
			create(EventSchema, {
				kind: EventKind.TYPING,
				channelId: 'c1',
				spaceId: 's1',
				typing: { channelId: 'c1', userId: 'u2', displayName: 'Bea' }
			}),
			ctx
		);
		expect([...state.typing.get('c1')!.entries()]).toEqual([['u2', { name: 'Bea', until: 1000 + TYPING_TTL_MS }]]);
		expect(expireTyping(state, 1000 + TYPING_TTL_MS - 1)).toBe(state);
		state = expireTyping(state, 1000 + TYPING_TTL_MS + 1);
		expect(state.typing.size).toBe(0);
	});

	it('ignores the caller typing', () => {
		const state = reduceEvent(
			emptyTimeline(),
			create(EventSchema, {
				kind: EventKind.TYPING,
				channelId: 'c1',
				spaceId: 's1',
				typing: { channelId: 'c1', userId: 'me', displayName: 'Me' }
			}),
			ctx
		);
		expect(state.typing.size).toBe(0);
	});

	it('stores presence and skips unchanged values', () => {
		const state = reduceEvent(
			emptyTimeline(),
			create(EventSchema, {
				kind: EventKind.PRESENCE_CHANGED,
				spaceId: 's1',
				presence: { userId: 'u2', status: 'idle' }
			}),
			ctx
		);
		expect(state.presence.get('u2')).toBe('idle');
		const same = reduceEvent(
			state,
			create(EventSchema, {
				kind: EventKind.PRESENCE_CHANGED,
				spaceId: 's1',
				presence: { userId: 'u2', status: 'idle' }
			}),
			ctx
		);
		expect(same).toBe(state);
	});
});
