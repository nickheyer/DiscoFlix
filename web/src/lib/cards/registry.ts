import { toJson, type DescMessage, type JsonValue, type Message, type MessageShape } from '@bufbuild/protobuf';
import { base64Encode } from '@bufbuild/protobuf/wire';
import { anyUnpack, StructSchema, type Any } from '@bufbuild/protobuf/wkt';
import type { Component } from 'svelte';
import { OPAQUE_TYPE_KEY, OPAQUE_TYPE_URL } from '#lib/api/any-json';
import { typeRegistry } from '#lib/api/types';

export type Accent = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export interface CardRenderer<Desc extends DescMessage = DescMessage> {
	schema: Desc;
	component: Component<{ card: MessageShape<Desc> }>;
	summary: (card: MessageShape<Desc>) => string;
	accent: (card: MessageShape<Desc>) => Accent;
}

export type ResolvedCard =
	| { kind: 'known'; typeUrl: string; typeName: string; renderer: CardRenderer; message: Message }
	| { kind: 'unknown'; typeUrl: string; typeName: string; json: JsonValue };

const TYPE_PREFIX = 'type.googleapis.com/';

const renderers = new Map<string, CardRenderer>();

export function typeNameOf(typeUrl: string): string {
	return typeUrl.slice(typeUrl.lastIndexOf('/') + 1);
}

export function typeUrlOf(typeName: string): string {
	return TYPE_PREFIX + typeName;
}

// Adds a renderer and makes its schema decodable from JSON, returning an unregister function
export function registerCard<Desc extends DescMessage>(renderer: CardRenderer<Desc>): () => void {
	const key = typeUrlOf(renderer.schema.typeName);
	renderers.set(key, renderer as unknown as CardRenderer);
	typeRegistry.add(renderer.schema);
	return () => {
		renderers.delete(key);
		typeRegistry.remove(renderer.schema);
	};
}

export function rendererFor(typeUrl: string): CardRenderer | undefined {
	return renderers.get(typeUrlOf(typeNameOf(typeUrl)));
}

function opaque(any: Any): ResolvedCard {
	const struct = anyUnpack(any, StructSchema);
	const json = struct ? toJson(StructSchema, struct) : null;
	if (json && typeof json === 'object' && !Array.isArray(json)) {
		const { [OPAQUE_TYPE_KEY]: original, ...rest } = json;
		if (typeof original === 'string' && original !== '') {
			return { kind: 'unknown', typeUrl: original, typeName: typeNameOf(original), json: rest };
		}
	}
	return { kind: 'unknown', typeUrl: any.typeUrl, typeName: StructSchema.typeName, json };
}

function raw(any: Any): ResolvedCard {
	return {
		kind: 'unknown',
		typeUrl: any.typeUrl,
		typeName: typeNameOf(any.typeUrl),
		json: { value: base64Encode(any.value) }
	};
}

// Finds the renderer for a card payload or describes it as an unknown typed JSON value
export function resolveCard(any: Any): ResolvedCard {
	const renderer = rendererFor(any.typeUrl);
	if (renderer) {
		try {
			const message = anyUnpack(any, renderer.schema);
			if (message) {
				return { kind: 'known', typeUrl: any.typeUrl, typeName: renderer.schema.typeName, renderer, message };
			}
		} catch {
			return raw(any);
		}
	}
	if (any.typeUrl === OPAQUE_TYPE_URL) return opaque(any);
	return raw(any);
}

export function cardSummary(card: ResolvedCard): string {
	return card.kind === 'known' ? card.renderer.summary(card.message) : card.typeName;
}

export function cardAccent(card: ResolvedCard): Accent {
	return card.kind === 'known' ? card.renderer.accent(card.message) : 'neutral';
}
