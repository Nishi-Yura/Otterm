/**
 * Kotsume's state (docs/08 §4, §6.2): the mood, picked from the reasons that are active now, and
 * the speech bubble queue.
 *
 * Moods: every cause (a long command, a danger prompt, a mod's setMood) sets a reason with a mood
 * and maybe a deadline; the mood shown is the strongest reason, alert > thinking > happy > calm.
 * Speech: one bubble at a time, queued; an alert interrupts. A mod may speak 3 times a minute
 * (§6.3); more is dropped and logged.
 */
import { createSignal } from "solid-js";
import type { Mood } from "./sprite";

/** What a line is for, which decides whether it is spoken at the current guide level (§4.3). */
export type SpeechKind = "alert" | "first" | "info";

export interface SpeechAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

export interface Speech {
  text: string;
  mood?: Mood;
  kind: SpeechKind;
  /** ms; 0 stays until closed. */
  durationMs?: number;
  actions?: SpeechAction[];
  /** `otterm` or a mod id, for the rate limit and the log. */
  source: string;
}

interface Queued extends Speech {
  id: number;
  done: () => void;
}

const RANK: Record<Mood, number> = { calm: 0, happy: 1, thinking: 2, alert: 3 };
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_DURATION_MS = 5000;

export class MascotStore {
  private reasons = new Map<string, { mood: Mood; timer?: ReturnType<typeof setTimeout> }>();
  private readonly moodSignal = createSignal<Mood>("calm");
  private readonly currentSignal = createSignal<Queued>();
  private queue: Queued[] = [];
  private nextId = 1;
  private spoken = new Map<string, number[]>();
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private moodListeners = new Set<(m: Mood) => void>();
  /** Whether moods change at all (`mascot.mood_changes`). */
  moodChanges = true;

  constructor(private log: (source: string, message: string) => void = () => {}) {}

  readonly mood = () => this.moodSignal[0]();
  readonly current = () => this.currentSignal[0]();

  /** Turn a reason on, optionally for `forMs` only. The same id replaces the earlier one. */
  setReason(id: string, mood: Mood, forMs?: number) {
    const old = this.reasons.get(id);
    if (old?.timer) clearTimeout(old.timer);
    const timer = forMs ? setTimeout(() => this.clearReason(id), forMs) : undefined;
    this.reasons.set(id, { mood, timer });
    this.update();
  }

  clearReason(id: string) {
    const old = this.reasons.get(id);
    if (!old) return;
    if (old.timer) clearTimeout(old.timer);
    this.reasons.delete(id);
    this.update();
  }

  hasReason(id: string): boolean {
    return this.reasons.has(id);
  }

  onMoodChanged(f: (m: Mood) => void): () => void {
    this.moodListeners.add(f);
    return () => this.moodListeners.delete(f);
  }

  private update() {
    let best: Mood = "calm";
    if (this.moodChanges) {
      for (const r of this.reasons.values()) if (RANK[r.mood] > RANK[best]) best = r.mood;
    }
    // The bubble's own mood counts as a reason while it shows.
    const c = this.current();
    if (this.moodChanges && c?.mood && RANK[c.mood] > RANK[best]) best = c.mood;
    if (best !== this.mood()) {
      this.moodSignal[1](best);
      for (const f of this.moodListeners) f(best);
    }
  }

  /** Queue a line; resolves when it is closed (or dropped). */
  say(s: Speech): Promise<void> {
    if (s.source !== "otterm" && !this.allowRate(s.source)) {
      this.log(s.source, "mascot.say: more than 3 lines a minute; dropped");
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const q: Queued = { ...s, id: this.nextId++, done: resolve };
      if (s.kind === "alert") {
        // An alert goes first; whatever showed waits behind it.
        const c = this.current();
        if (c && c.kind !== "alert") this.queue.unshift(c);
        this.show(q);
        return;
      }
      if (this.current()) this.queue.push(q);
      else this.show(q);
    });
  }

  private allowRate(source: string): boolean {
    const now = Date.now();
    const times = (this.spoken.get(source) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_LIMIT) return false;
    times.push(now);
    this.spoken.set(source, times);
    return true;
  }

  private show(q: Queued) {
    clearTimeout(this.closeTimer);
    this.currentSignal[1](q);
    this.update();
    const ms = q.durationMs ?? (q.actions?.length ? 0 : DEFAULT_DURATION_MS);
    if (ms > 0) this.closeTimer = setTimeout(() => this.close(q.id), ms);
  }

  /** Close the bubble showing now (or the given one), then show the next. */
  close(id?: number) {
    const c = this.current();
    if (!c || (id !== undefined && c.id !== id)) return;
    clearTimeout(this.closeTimer);
    this.currentSignal[1](undefined);
    c.done();
    this.update();
    const next = this.queue.shift();
    if (next) this.show(next);
  }

  /** Drop everything waiting (Kotsume was hidden). */
  clear() {
    for (const q of this.queue) q.done();
    this.queue = [];
    this.close();
  }
}
