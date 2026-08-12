import { describe, it, expect, afterEach } from "vitest";
import {
  LoopLagMonitor,
  markPhaseSync,
  setActiveMonitor,
  getActiveMonitor,
} from "./loop-lag.js";

// ---------------------------------------------------------------------------
// Diagnosis: when the server stalls, the logs never say which phase held the
// thread. Timers around an `await` measure wall clock, so a blocked loop makes
// every phase look slow at once. A lag monitor samples the loop directly and
// names whatever phase was marked when the gap happened.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The marker is process-wide; don't leak one test's monitor into the next.
afterEach(() => setActiveMonitor(null));

/** Hold the thread the way a synchronous scan does — no awaits. */
function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

describe("LoopLagMonitor", () => {
  it("reports nothing when the loop stays responsive", async () => {
    const seen: Array<{ lagMs: number; phase: string }> = [];
    const monitor = new LoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 200,
      onLag: (lagMs, phase) => seen.push({ lagMs, phase }),
    });
    monitor.start();
    await sleep(150);
    monitor.stop();

    expect(seen).toEqual([]);
  });

  it("reports a stall and names the phase that was running", async () => {
    const seen: Array<{ lagMs: number; phase: string }> = [];
    const monitor = new LoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 100,
      onLag: (lagMs, phase) => seen.push({ lagMs, phase }),
    });
    monitor.start();

    await monitor.phase("scan", async () => {
      blockFor(300);
    });
    await sleep(60);
    monitor.stop();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].phase).toBe("scan");
    expect(seen[0].lagMs).toBeGreaterThanOrEqual(100);
  });

  it("attributes a stall to the innermost active phase", async () => {
    const seen: string[] = [];
    const monitor = new LoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 100,
      onLag: (_lagMs, phase) => seen.push(phase),
    });
    monitor.start();

    await monitor.phase("tick", async () => {
      await monitor.phase("fts-index", async () => {
        blockFor(250);
      });
    });
    await sleep(60);
    monitor.stop();

    expect(seen[0]).toBe("fts-index");
  });

  it("falls back to a placeholder when no phase is marked", async () => {
    const seen: string[] = [];
    const monitor = new LoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 100,
      onLag: (_lagMs, phase) => seen.push(phase),
    });
    monitor.start();
    blockFor(250);
    await sleep(60);
    monitor.stop();

    expect(seen[0]).toBe("(unmarked)");
  });

  it("restores the previous phase even when the body throws", async () => {
    const monitor = new LoopLagMonitor({ intervalMs: 20, thresholdMs: 100, onLag: () => {} });
    monitor.start();

    await expect(
      monitor.phase("outer", async () => {
        await monitor.phase("inner", async () => { throw new Error("boom"); });
      }),
    ).rejects.toThrow("boom");

    expect(monitor.currentPhase()).toBe("(unmarked)");
    monitor.stop();
  });

  it("marks synchronous work, which is the work that actually blocks", async () => {
    const seen: string[] = [];
    const monitor = new LoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 100,
      onLag: (_lagMs, phase) => seen.push(phase),
    });
    monitor.start();
    setActiveMonitor(monitor);

    // A sync walk cannot await, so it needs a sync marker.
    markPhaseSync("scan", () => blockFor(250));
    await sleep(60);
    monitor.stop();

    expect(seen[0]).toBe("scan");
  });

  it("markPhaseSync is a no-op passthrough with no active monitor", () => {
    setActiveMonitor(null);
    expect(getActiveMonitor()).toBe(null);
    expect(markPhaseSync("scan", () => 42)).toBe(42);
  });

  it("markPhaseSync restores the phase when the body throws", () => {
    const monitor = new LoopLagMonitor({ intervalMs: 20, thresholdMs: 100, onLag: () => {} });
    setActiveMonitor(monitor);
    expect(() => markPhaseSync("scan", () => { throw new Error("boom"); })).toThrow("boom");
    expect(monitor.currentPhase()).toBe("(unmarked)");
  });

  it("stops sampling after stop()", async () => {
    let calls = 0;
    const monitor = new LoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 50,
      onLag: () => { calls++; },
    });
    monitor.start();
    monitor.stop();

    blockFor(200);
    await sleep(60);
    expect(calls).toBe(0);
  });
});
