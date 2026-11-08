import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import {
	Centrifuge,
	type PublicationContext,
	type StreamPosition,
	type SubscribedContext,
	type Subscription
} from 'centrifuge';
import { wrapUnknownAny } from '#lib/api/any-json';
import { typeRegistry } from '#lib/api/types';
import { EventSchema, type Event } from '#lib/gen/discoflix/timeline/v1/timeline_pb';

export type LinkState = 'disconnected' | 'connecting' | 'connected';

export interface StreamHandlers {
	onEvent: (event: Event) => void;
	onSubscribed: (info: { first: boolean; resumed: boolean }) => void;
	onError: (message: string) => void;
}

// Decodes a publication payload, the protobuf JSON encoding of a timeline Event
export function decodeEvent(data: unknown): Event {
	const json = wrapUnknownAny(EventSchema, data as JsonValue, typeRegistry);
	return fromJson(EventSchema, json, { registry: typeRegistry, ignoreUnknownFields: true });
}

export function channelTopic(spaceId: string, channelId: string): string {
	return `space:${spaceId}:channel:${channelId}`;
}

export function userTopic(userId: string): string {
	return `user:${userId}`;
}

class Realtime {
	state = $state<LinkState>('disconnected');
	error = $state('');
	#client: Centrifuge | null = null;
	#positions = new Map<string, StreamPosition>();

	connect(): void {
		if (this.#client) return;
		const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
		const client = new Centrifuge(`${scheme}://${window.location.host}/connection/websocket`, {
			name: 'discoflix-web'
		});
		client.on('state', (ctx) => (this.state = ctx.newState));
		client.on('connected', () => (this.error = ''));
		client.on('disconnected', (ctx) => (this.error = ctx.reason));
		client.on('error', (ctx) => (this.error = ctx.error.message));
		this.#client = client;
		client.connect();
	}

	disconnect(): void {
		this.#client?.disconnect();
		this.#client = null;
		this.#positions.clear();
		this.state = 'disconnected';
	}

	// Subscribes to a topic, resuming from the last recoverable position the server reported
	subscribe(topic: string, handlers: StreamHandlers): { sub: Subscription; close: () => void } {
		this.connect();
		const client = this.#client as Centrifuge;
		const existing = client.getSubscription(topic);
		if (existing) client.removeSubscription(existing);
		const since = this.#positions.get(topic);
		const sub = client.newSubscription(topic, since ? { since } : {});
		let first = true;
		sub.on('subscribed', (ctx: SubscribedContext) => {
			if (ctx.recoverable && ctx.streamPosition) this.#positions.set(topic, ctx.streamPosition);
			else this.#positions.delete(topic);
			handlers.onSubscribed({ first, resumed: ctx.wasRecovering && ctx.recovered });
			first = false;
		});
		sub.on('publication', (ctx: PublicationContext) => {
			const position = this.#positions.get(topic);
			if (position && ctx.offset !== undefined) this.#positions.set(topic, { ...position, offset: ctx.offset });
			try {
				handlers.onEvent(decodeEvent(ctx.data));
			} catch (err) {
				handlers.onError(err instanceof Error ? err.message : String(err));
			}
		});
		sub.on('error', (ctx) => handlers.onError(ctx.error.message));
		sub.subscribe();
		return {
			sub,
			close: () => {
				sub.unsubscribe();
				client.removeSubscription(sub);
			}
		};
	}
}

export const realtime = new Realtime();
