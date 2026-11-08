import { ApprovalSchema } from '#lib/gen/discoflix/card/v1/approval_pb';
import {
	BootReportSchema,
	SecurityEventSchema,
	SystemNoticeSchema,
	UpdateEventSchema
} from '#lib/gen/discoflix/card/v1/system_pb';
import ApprovalCard from './ApprovalCard.svelte';
import BootReportCard from './BootReportCard.svelte';
import SecurityEventCard from './SecurityEventCard.svelte';
import SystemNoticeCard from './SystemNoticeCard.svelte';
import UpdateEventCard from './UpdateEventCard.svelte';
import { registerCard } from './registry';
import {
	approvalAccent,
	approvalActions,
	approvalSummary,
	bootSummary,
	noticeAccent,
	noticeSummary,
	securityAccent,
	securitySummary,
	updateAccent,
	updateSummary
} from './summaries';

let registered = false;

// Registers the card types the core server posts to its system channels
export function registerBuiltinCards(): void {
	if (registered) return;
	registered = true;
	registerCard({
		schema: SystemNoticeSchema,
		component: SystemNoticeCard,
		summary: noticeSummary,
		accent: noticeAccent
	});
	registerCard({
		schema: BootReportSchema,
		component: BootReportCard,
		summary: bootSummary,
		accent: () => 'info'
	});
	registerCard({
		schema: SecurityEventSchema,
		component: SecurityEventCard,
		summary: securitySummary,
		accent: securityAccent
	});
	registerCard({
		schema: UpdateEventSchema,
		component: UpdateEventCard,
		summary: updateSummary,
		accent: updateAccent
	});
	registerCard({
		schema: ApprovalSchema,
		component: ApprovalCard,
		summary: approvalSummary,
		accent: approvalAccent,
		actions: approvalActions
	});
}
