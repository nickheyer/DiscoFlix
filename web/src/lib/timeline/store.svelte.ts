import type { QueryClient } from '@tanstack/svelte-query';
import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { timelineClient } from '#lib/api/clients';
import { errorText } from '#lib/api/errors';
import {
	EventKind,
	TimelineService,
	type Event,
	type ListChannelsResponse,
	type ListSpacesResponse,
	type Message
} from '#lib/gen/discoflix/timeline/v1/timeline_pb';
import { channelsKey, spacesKey } from '#lib/spaces/queries';
import {
	clearStale,
	emptyTimeline,
	mergeActivity,
	mergeLatest,
	mergeOlder,
	openChannel,
	reduceEvent,
	seedChannel,
	seedChannels,
	seedSpaces,
	type TimelineState
} from './reducer';
import { channelTopic, decodeEvent, realtime, userTopic } from './realtime.svelte';

export const PAGE_SIZE = 50;
const HISTORY_SIZE = 100;

type Load = { running: Promise<void>; again: boolean };

class TimelineStore {
	state = $state.raw<TimelineState>(emptyTimeline());
	readingChannelId = $state<string | null>(null);
	activityError = $state('');
	streamError = $state('');
	loadingOlder = new SvelteMap<string, boolean>();
	channelErrors = new SvelteMap<string, string>();
	readOnly = new SvelteSet<string>();
	drafts = new Map<string, string>();
	#selfId = '';
	#queries: QueryClient | null = null;
	#latest = new Map<string, Load>();
	#detach: (() => void)[] = [];

	#set(next: TimelineState): void {
		if (next.stale.size > 0) {
			const stale = [...next.stale];
			next = clearStale(next);
			void this.#queries?.invalidateQueries({ queryKey: spacesKey() });
			for (const spaceId of stale) void this.#queries?.invalidateQueries({ queryKey: channelsKey(spaceId) });
		}
		this.state = next;
	}

	// Applies an event without letting a calling effect subscribe to the whole store
	dispatch(event: Event): void {
		untrack(() =>
			this.#set(reduceEvent(this.state, event, { selfId: this.#selfId, readingChannelId: this.readingChannelId }))
		);
	}

	// Connects realtime for a signed-in user and keeps counters in sync with cached list queries
	start(selfId: string, queries: QueryClient): void {
		this.stop();
		this.#selfId = selfId;
		this.#queries = queries;
		this.#detach.push(
			queries.getQueryCache().subscribe((e) => {
				if (e.type !== 'updated' || e.action.type !== 'success') return;
				const [, key] = e.query.queryKey as [string, { serviceName?: string; methodName?: string; input?: unknown }];
				if (key.serviceName !== TimelineService.typeName) return;
				if (key.methodName === TimelineService.method.listSpaces.name) {
					this.#set(seedSpaces(this.state, (e.action.data as ListSpacesResponse).spaces));
				} else if (key.methodName === TimelineService.method.listChannels.name) {
					const spaceId = (key.input as { spaceId?: string } | undefined)?.spaceId ?? '';
					this.#set(seedChannels(this.state, spaceId, (e.action.data as ListChannelsResponse).channels));
				}
			})
		);
		realtime.connect();
		const stream = realtime.subscribe(userTopic(selfId), {
			onEvent: (event) => this.dispatch(event),
			onSubscribed: ({ first, resumed }) => {
				this.streamError = '';
				if (first || !resumed)
					void this.#loadActivity(stream.sub.history({ limit: HISTORY_SIZE, reverse: true }), !first);
				if (!first && !resumed) void queries.invalidateQueries({ queryKey: ['connect-query'] });
			},
			onError: (message) => (this.streamError = message)
		});
		this.#detach.push(stream.close);
	}

	stop(): void {
		for (const detach of this.#detach.splice(0)) detach();
		realtime.disconnect();
		this.state = emptyTimeline();
		this.readingChannelId = null;
		this.activityError = '';
		this.streamError = '';
		this.loadingOlder.clear();
		this.channelErrors.clear();
		this.readOnly.clear();
		this.drafts.clear();
		this.#latest.clear();
		this.#selfId = '';
	}

	// Seeds recent activity from user channel history, replacing it after a gap the server could not recover
	async #loadActivity(history: Promise<{ publications: { data: unknown }[] }>, replace: boolean): Promise<void> {
		try {
			const { publications } = await history;
			const latest = new Map<bigint, Message>();
			const order: bigint[] = [];
			for (const publication of [...publications].reverse()) {
				const event = decodeEvent(publication.data);
				const message = event.message;
				if (!message) continue;
				if (event.kind === EventKind.MESSAGE_DELETED) {
					latest.delete(message.seq);
					continue;
				}
				if (event.kind === EventKind.CHANNEL_READ) continue;
				const known = latest.get(message.seq);
				const merged = event.kind === EventKind.CARD_UPDATED && known ? { ...known, card: message.card } : message;
				if (!merged.card) continue;
				latest.set(message.seq, merged);
				order.push(message.seq);
			}
			const newestFirst: Message[] = [];
			const seen = new Set<bigint>();
			for (const seq of order.reverse()) {
				const message = latest.get(seq);
				if (!message || seen.has(seq)) continue;
				seen.add(seq);
				newestFirst.push(message);
			}
			this.#set(mergeActivity(this.state, newestFirst, replace));
			this.activityError = '';
		} catch (err) {
			this.activityError = errorText(err);
		}
	}

	// Follows one channel live and loads its newest page, reloading after any unrecovered reconnect
	open(spaceId: string, channelId: string): () => void {
		return untrack(() => this.#follow(spaceId, channelId));
	}

	#follow(spaceId: string, channelId: string): () => void {
		this.#set(openChannel(this.state, channelId));
		void this.loadLatest(channelId);
		const stream = realtime.subscribe(channelTopic(spaceId, channelId), {
			onEvent: (event) => this.dispatch(event),
			onSubscribed: ({ resumed }) => {
				this.channelErrors.delete(channelId);
				if (!resumed) void this.loadLatest(channelId);
			},
			onError: (message) => this.channelErrors.set(channelId, message)
		});
		return stream.close;
	}

	loadLatest(channelId: string): Promise<void> {
		const current = this.#latest.get(channelId);
		if (current) {
			current.again = true;
			return current.running;
		}
		const load: Load = { running: Promise.resolve(), again: false };
		load.running = (async () => {
			do {
				load.again = false;
				try {
					const res = await timelineClient.listMessages({ channelId, beforeSeq: 0n, limit: PAGE_SIZE });
					this.#set(mergeLatest(this.state, channelId, res.messages, res.hasMore));
					this.channelErrors.delete(channelId);
				} catch (err) {
					this.channelErrors.set(channelId, errorText(err));
				}
			} while (load.again);
			this.#latest.delete(channelId);
		})();
		this.#latest.set(channelId, load);
		return load.running;
	}

	async loadOlder(channelId: string): Promise<void> {
		const current = untrack(() => this.state.messages.get(channelId));
		if (!current || !current.hasOlder || untrack(() => this.loadingOlder.get(channelId))) return;
		const oldest = current.items[0]?.seq ?? 0n;
		if (oldest === 0n) return;
		this.loadingOlder.set(channelId, true);
		try {
			const res = await timelineClient.listMessages({ channelId, beforeSeq: oldest, limit: PAGE_SIZE });
			this.#set(mergeOlder(this.state, channelId, res.messages, res.hasMore));
		} catch (err) {
			this.channelErrors.set(channelId, errorText(err));
		} finally {
			this.loadingOlder.delete(channelId);
		}
	}

	async markRead(channelId: string, seq: bigint): Promise<void> {
		const res = await timelineClient.markRead({ channelId, seq });
		if (res.channel) this.#set(seedChannel(this.state, res.channel));
	}
}

export const timeline = new TimelineStore();
