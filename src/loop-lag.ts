// ---------------------------------------------------------------------------
// Event-loop lag monitor
//
// Gloss runs everything — HTTP, scanning, SQLite, indexing — on one JS thread.
// When something holds that thread, every request queues behind it and the
// server looks dead while being perfectly healthy by every other measure.
//
// Timers around an `await` cannot tell you who did the holding: they measure
// wall clock, so a blocked loop inflates whatever phase happens to span it.
// (That is how an 85s "vector search" turned out to be 37ms of vector search.)
//
// This samples the loop on a fixed interval and reports the gap between when
// a tick was due and when it actually ran, tagged with the phase that was
// marked at the time. That turns "the server stalled" into "the scan phase
// held the thread for 13.1s".
// ---------------------------------------------------------------------------

const UNMARKED = "(unmarked)";

export interface LoopLagOptions {
  /** How often to sample the loop. */
  intervalMs?: number;
  /** Only report gaps at or above this. */
  thresholdMs?: number;
  /** Called once per sample that exceeds the threshold. */
  onLag: (lagMs: number, phase: string) => void;
}

export class LoopLagMonitor {
  private intervalMs: number;
  private thresholdMs: number;
  private onLag: (lagMs: number, phase: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private expectedAt = 0;
  private phaseStack: string[] = [];
  private worst = { lagMs: 0, phase: UNMARKED };
  /**
   * Phases that ended since the last sample. A phase that blocks the thread
   * has usually finished — and been popped — by the time the sampling timer
   * gets to run, so the stack alone would report "(unmarked)" for exactly the
   * stalls worth naming.
   */
  private endedSinceTick: Array<{ phase: string; at: number }> = [];

  constructor(options: LoopLagOptions) {
    this.intervalMs = options.intervalMs ?? 500;
    this.thresholdMs = options.thresholdMs ?? 1_000;
    this.onLag = options.onLag;
  }

  /** The phase a stall right now would be attributed to. */
  currentPhase(): string {
    return this.phaseStack.length > 0
      ? this.phaseStack[this.phaseStack.length - 1]
      : UNMARKED;
  }

  /** Worst lag observed since start. */
  worstLag(): { lagMs: number; phase: string } {
    return { ...this.worst };
  }

  /**
   * Run `body` with the loop tagged as `name`. Nests: a stall is blamed on the
   * innermost phase, which is the one actually doing the work.
   */
  async phase<T>(name: string, body: () => Promise<T> | T): Promise<T> {
    this.enter(name);
    try {
      return await body();
    } finally {
      this.exit(name);
    }
  }

  /** Begin a phase. Prefer `phase()`; this exists for synchronous callers. */
  enter(name: string): void {
    this.phaseStack.push(name);
  }

  /** End the innermost phase. */
  exit(name: string): void {
    this.phaseStack.pop();
    // Innermost phases pop first, so the head of this list is the most
    // specific candidate for whatever blocked the loop.
    if (this.endedSinceTick.length < 16) {
      this.endedSinceTick.push({ phase: name, at: Date.now() });
    }
  }

  /** Who to blame for a gap that ended at `now` and was due at `due`. */
  private attribute(due: number): string {
    const active = this.currentPhase();
    if (active !== UNMARKED) return active;
    const during = this.endedSinceTick.find((p) => p.at >= due - this.intervalMs);
    return during?.phase ?? UNMARKED;
  }

  start(): void {
    if (this.timer) return;
    this.expectedAt = Date.now() + this.intervalMs;
    this.timer = setInterval(() => {
      const now = Date.now();
      const due = this.expectedAt;
      const lag = now - due;
      this.expectedAt = now + this.intervalMs;
      if (lag >= this.thresholdMs) {
        const phase = this.attribute(due);
        if (lag > this.worst.lagMs) this.worst = { lagMs: lag, phase };
        this.onLag(lag, phase);
      }
      this.endedSinceTick.length = 0;
    }, this.intervalMs);
    // A diagnostic must never be the reason the process stays alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------------------
// Process-wide marker
//
// The phases worth naming (the scan walk, FTS batches, embedding writes) live
// in modules the server calls but does not own, so plumbing a monitor handle
// through every signature would touch more code than the diagnosis is worth.
// One process-wide monitor, opt-in via GLOSS_LAG_MS, keeps the marking local
// to the code that actually blocks.
// ---------------------------------------------------------------------------

let active: LoopLagMonitor | null = null;

export function setActiveMonitor(monitor: LoopLagMonitor | null): void {
  active = monitor;
}

export function getActiveMonitor(): LoopLagMonitor | null {
  return active;
}

/** Lazily build the default monitor when GLOSS_LAG_MS asks for one. */
function ensureMonitor(): LoopLagMonitor | null {
  if (active) return active;
  const thresholdMs = Number(process.env.GLOSS_LAG_MS);
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return null;
  const monitor = new LoopLagMonitor({
    intervalMs: 500,
    thresholdMs,
    onLag: (lagMs, phase) =>
      console.warn(`[lag] event loop blocked ${lagMs}ms during "${phase}"`),
  });
  monitor.start();
  active = monitor;
  return monitor;
}

/** Mark synchronous work — the kind that actually holds the thread. */
export function markPhaseSync<T>(name: string, body: () => T): T {
  const monitor = ensureMonitor();
  if (!monitor) return body();
  monitor.enter(name);
  try {
    return body();
  } finally {
    monitor.exit(name);
  }
}

/** Mark an async span (its synchronous stretches get attributed to it). */
export async function markPhase<T>(name: string, body: () => Promise<T> | T): Promise<T> {
  const monitor = ensureMonitor();
  if (!monitor) return await body();
  return monitor.phase(name, body);
}
