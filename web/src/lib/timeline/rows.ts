import type { Message } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
import { sameDay, toDate } from '#lib/theme/format';

export const GROUP_WINDOW_MS = 7 * 60 * 1000;

export type Row =
	| { kind: 'start'; key: string }
	| { kind: 'older'; key: string }
	| { kind: 'day'; key: string; date: Date }
	| { kind: 'message'; key: string; message: Message; date: Date; grouped: boolean };

// Decides whether a message continues the visual group started by the previous one
export function continuesGroup(prev: Message | undefined, next: Message): boolean {
	if (!prev || next.replyTo !== 0n || prev.deletedAt || next.deletedAt || prev.kind !== next.kind) return false;
	if (!prev.author || !next.author || prev.author.id !== next.author.id) return false;
	const a = toDate(prev.createdAt);
	const b = toDate(next.createdAt);
	if (!a || !b || !sameDay(a, b)) return false;
	const gap = b.getTime() - a.getTime();
	return gap >= 0 && gap <= GROUP_WINDOW_MS;
}

// Builds timeline rows with a header, day separators, and grouping flags
export function buildRows(messages: readonly Message[], hasOlder: boolean): Row[] {
	const rows: Row[] = [hasOlder ? { kind: 'older', key: 'older' } : { kind: 'start', key: 'start' }];
	let prev: Message | undefined;
	let prevDate: Date | undefined;
	for (const message of messages) {
		const date = toDate(message.createdAt) ?? prevDate ?? new Date(0);
		if (!prevDate || !sameDay(prevDate, date)) {
			rows.push({ kind: 'day', key: `day${message.seq}`, date });
		}
		rows.push({ kind: 'message', key: `m${message.seq}`, message, date, grouped: continuesGroup(prev, message) });
		prev = message;
		prevDate = date;
	}
	return rows;
}
