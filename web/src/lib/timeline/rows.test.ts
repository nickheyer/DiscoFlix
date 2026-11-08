import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { AuthorSchema, MessageKind, MessageSchema } from '#lib/gen/discoflix/timeline/v1/timeline_pb';
import { buildRows } from './rows';

function msg(seq: number, at: string, author = 'a', replyTo = 0) {
	return create(MessageSchema, {
		seq: BigInt(seq),
		kind: MessageKind.USER,
		author: create(AuthorSchema, { id: author }),
		replyTo: BigInt(replyTo),
		createdAt: timestampFromDate(new Date(at))
	});
}

describe('buildRows', () => {
	it('groups messages from one author within seven minutes on the same day', () => {
		const rows = buildRows(
			[
				msg(1, '2026-11-08T10:00:00'),
				msg(2, '2026-11-08T10:06:00'),
				msg(3, '2026-11-08T10:14:00'),
				msg(4, '2026-11-08T10:15:00', 'b'),
				msg(5, '2026-11-08T10:16:00', 'b', 4)
			],
			false
		);
		const grouped = rows.flatMap((r) => (r.kind === 'message' ? [r.grouped] : []));
		expect(rows[0].kind).toBe('start');
		expect(grouped).toEqual([false, true, false, false, false]);
	});

	it('inserts a separator per day and keeps keys unique when dates go backwards', () => {
		const rows = buildRows(
			[msg(1, '2026-11-05T10:00:00'), msg(2, '2026-11-07T10:00:00'), msg(3, '2026-11-05T11:00:00')],
			true
		);
		const keys = rows.map((r) => r.key);
		expect(rows[0].kind).toBe('older');
		expect(rows.filter((r) => r.kind === 'day')).toHaveLength(3);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
