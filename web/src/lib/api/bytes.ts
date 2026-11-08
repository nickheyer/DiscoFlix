const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function jsonBytes(value: unknown): Uint8Array {
	return encoder.encode(JSON.stringify(value));
}

export function bytesJson<T>(bytes: Uint8Array): T {
	return JSON.parse(decoder.decode(bytes)) as T;
}
