export interface AgentInfo {
	label: string;
	mobile: boolean;
}

const browsers: [RegExp, string][] = [
	[/Edg\//, 'Edge'],
	[/OPR\//, 'Opera'],
	[/Firefox\//, 'Firefox'],
	[/Chrome\//, 'Chrome'],
	[/Safari\//, 'Safari']
];

const systems: [RegExp, string][] = [
	[/iPhone|iPad|iPod/, 'iOS'],
	[/Android/, 'Android'],
	[/Windows/, 'Windows'],
	[/Mac OS X|Macintosh/, 'macOS'],
	[/CrOS/, 'ChromeOS'],
	[/Linux/, 'Linux']
];

// Summarizes a user agent as browser and operating system for the sessions list
export function describeAgent(ua: string): AgentInfo {
	if (!ua) return { label: 'Unknown device', mobile: false };
	const browser = browsers.find(([re]) => re.test(ua))?.[1];
	const system = systems.find(([re]) => re.test(ua))?.[1];
	const mobile = /Mobi|Android|iPhone|iPad/.test(ua);
	if (!browser && !system) return { label: ua.split(/[\s/]/)[0] || 'Unknown device', mobile };
	return { label: [browser, system].filter(Boolean).join(' on '), mobile };
}
