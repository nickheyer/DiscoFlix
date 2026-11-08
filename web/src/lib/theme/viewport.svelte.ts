import { MediaQuery } from 'svelte/reactivity';

// Tracks the visual viewport so fixed layouts stay above the on-screen keyboard
export function trackViewport(): () => void {
	const vv = window.visualViewport;
	const root = document.documentElement;
	const apply = () => {
		const height = vv ? vv.height : window.innerHeight;
		root.style.setProperty('--app-height', `${Math.round(height)}px`);
		root.style.setProperty('--app-offset', `${Math.round(vv ? vv.offsetTop : 0)}px`);
	};
	apply();
	vv?.addEventListener('resize', apply);
	vv?.addEventListener('scroll', apply);
	window.addEventListener('resize', apply);
	return () => {
		vv?.removeEventListener('resize', apply);
		vv?.removeEventListener('scroll', apply);
		window.removeEventListener('resize', apply);
	};
}

class PageVisibility {
	visible = $state(document.visibilityState === 'visible');

	constructor() {
		document.addEventListener('visibilitychange', () => {
			this.visible = document.visibilityState === 'visible';
		});
	}
}

export const pageVisibility = new PageVisibility();

export const mobile = new MediaQuery('max-width: 767.98px');
