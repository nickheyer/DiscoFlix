import { create, fromJson, toJson, type JsonValue } from '@bufbuild/protobuf';
import { anyPack, type Any } from '@bufbuild/protobuf/wkt';
import type { Component } from 'svelte';
import { beforeAll, describe, expect, it } from 'vitest';
import { OPAQUE_TYPE_URL, wrapUnknownAny } from '#lib/api/any-json';
import { typeRegistry } from '#lib/api/types';
import {
	BootReportSchema,
	SecurityEventSchema,
	Severity,
	SystemNoticeSchema,
	UpdateEventSchema,
	type SystemNotice
} from '#lib/gen/discoflix/card/v1/system_pb';
import { ListMessagesResponseSchema } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
import { registerBuiltinCards } from './builtin';
import { cardAccent, cardSummary, registerCard, rendererFor, resolveCard, typeUrlOf } from './registry';

function decodeCard(json: JsonValue): Any {
	const wrapped = wrapUnknownAny(ListMessagesResponseSchema, { messages: [{ seq: '1', card: json }] }, typeRegistry);
	const res = fromJson(ListMessagesResponseSchema, wrapped, { registry: typeRegistry });
	const card = res.messages[0].card;
	if (!card) throw new Error('card missing');
	return card;
}

describe('card registry', () => {
	beforeAll(() => registerBuiltinCards());

	it('registers renderers for every system card type by type URL', () => {
		for (const schema of [SystemNoticeSchema, BootReportSchema, SecurityEventSchema, UpdateEventSchema]) {
			expect(rendererFor(typeUrlOf(schema.typeName))?.schema).toBe(schema);
			expect(typeRegistry.getMessage(schema.typeName)).toBe(schema);
		}
	});

	it('resolves a packed system notice with its summary and severity accent', () => {
		const card = anyPack(
			SystemNoticeSchema,
			create(SystemNoticeSchema, { title: 'Disk low', body: '5% left', severity: Severity.WARNING })
		);
		const resolved = resolveCard(card);
		expect(resolved.kind).toBe('known');
		expect(resolved.typeName).toBe('discoflix.card.v1.SystemNotice');
		expect(cardSummary(resolved)).toBe('Disk low');
		expect(cardAccent(resolved)).toBe('warning');
	});

	it('summarizes boot, security, and update cards', () => {
		const boot = resolveCard(
			anyPack(BootReportSchema, create(BootReportSchema, { version: '4.0.0', mode: 'headless' }))
		);
		const security = resolveCard(
			anyPack(SecurityEventSchema, create(SecurityEventSchema, { action: 'apikey_revoked' }))
		);
		const update = resolveCard(
			anyPack(UpdateEventSchema, create(UpdateEventSchema, { stage: 'failed', availableVersion: '4.1.0' }))
		);
		expect(cardSummary(boot)).toBe('DiscoFlix 4.0.0 started in headless mode');
		expect(cardSummary(security)).toBe('API key revoked');
		expect(cardAccent(security)).toBe('warning');
		expect(cardSummary(update)).toBe('Update to 4.1.0 failed');
		expect(cardAccent(update)).toBe('danger');
	});

	it('decodes known cards from protobuf JSON through the shared registry', () => {
		const card = decodeCard({ '@type': typeUrlOf('discoflix.card.v1.SystemNotice'), title: 'From JSON' });
		const resolved = resolveCard(card);
		expect(resolved.kind).toBe('known');
		expect(cardSummary(resolved)).toBe('From JSON');
	});

	it('keeps unknown JSON card types readable with their original type and payload', () => {
		const card = decodeCard({
			'@type': 'type.googleapis.com/acme.plugin.v1.Download',
			title: 'Ubuntu ISO',
			progress: 0.62,
			files: [{ name: 'ubuntu.iso' }]
		});
		expect(card.typeUrl).toBe(OPAQUE_TYPE_URL);
		const resolved = resolveCard(card);
		expect(resolved).toEqual({
			kind: 'unknown',
			typeUrl: 'type.googleapis.com/acme.plugin.v1.Download',
			typeName: 'acme.plugin.v1.Download',
			json: { title: 'Ubuntu ISO', progress: 0.62, files: [{ name: 'ubuntu.iso' }] }
		});
		expect(cardSummary(resolved)).toBe('acme.plugin.v1.Download');
		expect(cardAccent(resolved)).toBe('neutral');
	});

	it('shows binary payloads of unregistered types as base64', () => {
		const card: Any = {
			$typeName: 'google.protobuf.Any',
			typeUrl: 'type.googleapis.com/x.y.Z',
			value: new Uint8Array([1, 2, 3])
		};
		expect(resolveCard(card)).toEqual({
			kind: 'unknown',
			typeUrl: 'type.googleapis.com/x.y.Z',
			typeName: 'x.y.Z',
			json: { value: 'AQID' }
		});
	});

	describe('plugin registration', () => {
		const schema = SystemNoticeSchema;
		let unregister: () => void = () => undefined;

		beforeAll(() => {
			unregister = registerCard({
				schema,
				component: (() => undefined) as unknown as Component<{ card: SystemNotice }>,
				summary: () => 'override',
				accent: () => 'success'
			});
		});

		it('lets a later registration replace a renderer and remove it again', () => {
			const card = anyPack(schema, create(schema, { title: 'x' }));
			expect(cardSummary(resolveCard(card))).toBe('override');
			unregister();
			expect(rendererFor(card.typeUrl)).toBeUndefined();
			expect(resolveCard(card).kind).toBe('unknown');
			expect(toJson(schema, create(schema, { title: 'x' }))).toEqual({ title: 'x' });
		});
	});
});
