import type { DescField, DescMessage, JsonObject, JsonValue, Registry } from '@bufbuild/protobuf';

export const OPAQUE_TYPE_URL = 'type.googleapis.com/google.protobuf.Struct';
export const OPAQUE_TYPE_KEY = '@type';

const ANY_NAME = 'google.protobuf.Any';

function isObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWellKnown(desc: DescMessage): boolean {
	return desc.file.name.startsWith('google/protobuf/');
}

// Rewrites Any payloads with unregistered types into Struct carriers that keep the original type URL
export function wrapUnknownAny(desc: DescMessage, json: JsonValue, registry: Registry): JsonValue {
	if (!isObject(json)) return json;
	if (desc.typeName === ANY_NAME) return wrapAny(json, registry);
	if (isWellKnown(desc)) return json;
	let out: JsonObject | undefined;
	for (const field of desc.fields) {
		const key = field.jsonName in json ? field.jsonName : field.name in json ? field.name : '';
		if (key === '') continue;
		const value = json[key];
		const next = wrapField(field, value, registry);
		if (next !== value) {
			out ??= { ...json };
			out[key] = next;
		}
	}
	return out ?? json;
}

function wrapAny(json: JsonObject, registry: Registry): JsonValue {
	const typeUrl = json[OPAQUE_TYPE_KEY];
	if (typeof typeUrl !== 'string' || typeUrl === '') return json;
	const desc = registry.getMessage(typeUrl.slice(typeUrl.lastIndexOf('/') + 1));
	if (!desc) return { [OPAQUE_TYPE_KEY]: OPAQUE_TYPE_URL, value: json };
	if (isWellKnown(desc)) return json;
	return wrapUnknownAny(desc, json, registry);
}

function wrapField(field: DescField, value: JsonValue, registry: Registry): JsonValue {
	switch (field.fieldKind) {
		case 'message':
			return wrapUnknownAny(field.message, value, registry);
		case 'list': {
			if (field.listKind !== 'message' || !Array.isArray(value)) return value;
			const message = field.message;
			const next = value.map((item) => wrapUnknownAny(message, item, registry));
			return next.some((item, i) => item !== value[i]) ? next : value;
		}
		case 'map': {
			if (field.mapKind !== 'message' || !isObject(value)) return value;
			const message = field.message;
			let out: JsonObject | undefined;
			for (const [key, item] of Object.entries(value)) {
				const next = wrapUnknownAny(message, item, registry);
				if (next !== item) {
					out ??= { ...value };
					out[key] = next;
				}
			}
			return out ?? value;
		}
		default:
			return value;
	}
}

// Reports whether any Any field is reachable from a message type
export function reachesAny(desc: DescMessage, seen = new Set<string>()): boolean {
	if (desc.typeName === ANY_NAME) return true;
	if (isWellKnown(desc) || seen.has(desc.typeName)) return false;
	seen.add(desc.typeName);
	return desc.fields.some((field) => {
		if (field.fieldKind === 'message') return reachesAny(field.message, seen);
		if (field.fieldKind === 'list' && field.listKind === 'message') return reachesAny(field.message, seen);
		if (field.fieldKind === 'map' && field.mapKind === 'message') return reachesAny(field.message, seen);
		return false;
	});
}
