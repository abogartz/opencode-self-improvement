// Bounded per-session state for a long-lived server. The plugin keeps several
// session-keyed maps (epoch, latest prompt, stats, measured usage); a resident
// `opencode serve` would otherwise hold an entry per session it ever saw. One
// recency list owns eviction so the maps are always dropped together: an
// evicted session simply starts over (no block until its next prompt, then a
// "first" epoch), which costs one recompute and never serves stale state.
// Same cap as repokey.ts's session-scope cache.
export const SESSION_CAP = 64;

export class SessionLru {
	private readonly order = new Set<string>();
	private readonly cap: number;
	private readonly onEvict: (sid: string) => void;

	constructor(cap: number, onEvict: (sid: string) => void) {
		this.cap = cap;
		this.onEvict = onEvict;
	}

	// Mark a session as just used; evicts the least recently used beyond the cap.
	touch(sid: string): void {
		this.order.delete(sid);
		this.order.add(sid);
		while (this.order.size > this.cap) {
			const oldest = this.order.values().next().value as string;
			this.order.delete(oldest);
			this.onEvict(oldest);
		}
	}

	get size(): number {
		return this.order.size;
	}
}
