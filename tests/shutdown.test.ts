import { describe, it, expect, vi } from "vitest";

/**
 * Shutdown handler tests.
 *
 * The shutdown function is defined inline in index.ts (not exported).
 * These tests verify the PATTERN (shuttingDown guard, db.close, server.close)
 * by recreating the logic with mocks.
 */

function createShutdownHandler(deps: {
  server: { close: () => Promise<void> };
  db: { close: () => void };
  exit: (code: number) => void;
  pollTimer?: ReturnType<typeof setInterval> | null;
}) {
  let shuttingDown = false;

  return function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (deps.pollTimer) clearInterval(deps.pollTimer);
    deps.server.close().catch(() => {});
    deps.db.close();
    deps.exit(0);
  };
}

describe("shutdown", () => {
  it("calls db.close and process.exit(0)", () => {
    const dbClose = vi.fn();
    const serverClose = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    const shutdown = createShutdownHandler({
      server: { close: serverClose },
      db: { close: dbClose },
      exit,
    });

    shutdown();

    expect(dbClose).toHaveBeenCalledOnce();
    expect(serverClose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("double shutdown is guarded (db.close called only once)", () => {
    const dbClose = vi.fn();
    const serverClose = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    const shutdown = createShutdownHandler({
      server: { close: serverClose },
      db: { close: dbClose },
      exit,
    });

    shutdown();
    shutdown();

    expect(dbClose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("clears poll timer during shutdown", () => {
    const dbClose = vi.fn();
    const serverClose = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    // Create a real timer to pass in
    const timer = setInterval(() => {}, 999999);

    const shutdown = createShutdownHandler({
      server: { close: serverClose },
      db: { close: dbClose },
      exit,
      pollTimer: timer,
    });

    shutdown();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    clearIntervalSpy.mockRestore();
    clearInterval(timer); // cleanup
  });

  it("handles null poll timer gracefully during shutdown", () => {
    const dbClose = vi.fn();
    const serverClose = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    const shutdown = createShutdownHandler({
      server: { close: serverClose },
      db: { close: dbClose },
      exit,
      pollTimer: null,
    });

    // Should not throw
    expect(() => shutdown()).not.toThrow();
    expect(dbClose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
