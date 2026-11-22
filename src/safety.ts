// Which addresses text and keys may go to. No Obsidian parts, so it can be tested on its own.

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
const PRIVATE = /^(10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[a-z0-9-]+\.local)$/i;

/**
 * Whether text may be sent to this address. A key goes only over an encrypted (https) line, or to
 * this device itself. A plain http address is allowed only on this device or the home network.
 * Returns null when it is safe, else the reason in plain words.
 */
export function addressProblem(url: string, withKey: boolean): string | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return "That is not a web address.";
	}
	if (u.username || u.password) return "Put the key in the Key box, not in the address.";
	if (u.protocol === "https:") return null;
	if (u.protocol !== "http:") return "The address must start with https://.";
	const host = u.hostname;
	if (LOOPBACK.test(host)) return null;
	if (withKey) return "A key is only sent over https, so it cannot be read on the way.";
	if (PRIVATE.test(host)) return null;
	return "Use https for an address outside this device and your home network.";
}

export function isLoopback(url: string): boolean {
	try {
		return LOOPBACK.test(new URL(url).hostname);
	} catch {
		return false;
	}
}
