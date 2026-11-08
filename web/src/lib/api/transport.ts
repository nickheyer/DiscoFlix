import { getOption, type DescMessage, type DescService, type JsonValue } from '@bufbuild/protobuf';
import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { CapabilityService } from '#lib/gen/discoflix/capability/v1/capability_pb';
import { capability } from '#lib/gen/discoflix/capability/v1/options_pb';
import { CatalogService } from '#lib/gen/discoflix/catalog/v1/catalog_pb';
import { DiscordService } from '#lib/gen/discoflix/discord/v1/discord_pb';
import { IdentityService } from '#lib/gen/discoflix/identity/v1/identity_pb';
import { TimelineService } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
import { reachesAny, wrapUnknownAny } from './any-json';
import { emitUnauthenticated } from './auth-signal';
import { typeRegistry } from './types';

export const services: readonly DescService[] = [
	IdentityService,
	TimelineService,
	CapabilityService,
	DiscordService,
	CatalogService
];

const anyOutputs = new Map<string, DescMessage>();
for (const service of services) {
	for (const method of service.methods) {
		if (reachesAny(method.output)) anyOutputs.set(`/${service.typeName}/${method.name}`, method.output);
	}
}

function requestPath(input: RequestInfo | URL): string {
	const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	return new URL(href, window.location.href).pathname;
}

// Sends the session cookie and makes unknown card types decodable before protobuf parsing
async function cardSafeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const response = await globalThis.fetch(input, { ...init, credentials: 'same-origin' });
	const output = anyOutputs.get(requestPath(input));
	const type = response.headers.get('content-type') ?? '';
	if (!output || !response.ok || !type.startsWith('application/json')) return response;
	const json = (await response.json()) as JsonValue;
	const headers = new Headers(response.headers);
	headers.delete('content-length');
	headers.delete('content-encoding');
	return new Response(JSON.stringify(wrapUnknownAny(output, json, typeRegistry)), {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

const sessionInterceptor: Interceptor = (next) => async (req) => {
	try {
		return await next(req);
	} catch (err) {
		const isPublic = getOption(req.method, capability).public;
		if (!isPublic && ConnectError.from(err).code === Code.Unauthenticated) emitUnauthenticated();
		throw err;
	}
};

export const transport = createConnectTransport({
	baseUrl: window.location.origin,
	useBinaryFormat: false,
	fetch: cardSafeFetch,
	interceptors: [sessionInterceptor],
	jsonOptions: { registry: typeRegistry, ignoreUnknownFields: true }
});
