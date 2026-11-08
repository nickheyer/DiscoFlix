import {
	Severity,
	type BootReport,
	type SecurityEvent,
	type SystemNotice,
	type UpdateEvent
} from '#lib/gen/discoflix/card/v1/system_pb';
import type { Accent } from './registry';

const securityLabels: Record<string, string> = {
	login: 'Signed in',
	logout: 'Signed out',
	bootstrap: 'Administrator created',
	password_changed: 'Password changed',
	passkey_added: 'Passkey added',
	passkey_removed: 'Passkey removed',
	apikey_created: 'API key created',
	apikey_revoked: 'API key revoked',
	session_revoked: 'Session revoked'
};

function humanize(text: string): string {
	const spaced = text.replaceAll('_', ' ').trim();
	return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : 'Security event';
}

export function noticeSummary(card: SystemNotice): string {
	return card.title || card.body.split('\n')[0] || 'Notice';
}

export function noticeAccent(card: SystemNotice): Accent {
	switch (card.severity) {
		case Severity.INFO:
			return 'info';
		case Severity.SUCCESS:
			return 'success';
		case Severity.WARNING:
			return 'warning';
		case Severity.ERROR:
			return 'danger';
		default:
			return 'neutral';
	}
}

export function bootSummary(card: BootReport): string {
	const version = card.version ? `DiscoFlix ${card.version}` : 'DiscoFlix';
	return card.mode ? `${version} started in ${card.mode} mode` : `${version} started`;
}

export function securitySummary(card: SecurityEvent): string {
	return securityLabels[card.action] ?? humanize(card.action);
}

export function securityAccent(card: SecurityEvent): Accent {
	if (card.action === 'bootstrap') return 'success';
	if (card.action.endsWith('_revoked') || card.action.endsWith('_removed')) return 'warning';
	return 'info';
}

export function updateSummary(card: UpdateEvent): string {
	const target = card.availableVersion;
	switch (card.stage) {
		case 'checked':
			return target ? `Update ${target} is available` : `DiscoFlix ${card.currentVersion} is up to date`;
		case 'downloaded':
			return `Update ${target} downloaded`;
		case 'verified':
			return `Update ${target} verified`;
		case 'applied':
			return `Updated to ${target}`;
		case 'failed':
			return target ? `Update to ${target} failed` : 'Update failed';
		default:
			return `Update ${humanize(card.stage).toLowerCase()}`;
	}
}

export function updateAccent(card: UpdateEvent): Accent {
	if (card.stage === 'failed') return 'danger';
	if (card.stage === 'applied') return 'success';
	if (card.stage === 'checked' && card.availableVersion) return 'info';
	return 'neutral';
}
