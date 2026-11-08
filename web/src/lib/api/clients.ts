import { createClient } from '@connectrpc/connect';
import { CapabilityService } from '#lib/gen/discoflix/capability/v1/capability_pb';
import { IdentityService } from '#lib/gen/discoflix/identity/v1/identity_pb';
import { TimelineService } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
import { transport } from './transport';

export const identityClient = createClient(IdentityService, transport);
export const timelineClient = createClient(TimelineService, transport);
export const capabilityClient = createClient(CapabilityService, transport);
