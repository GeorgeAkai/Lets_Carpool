import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE, PENDING_POLL_INTERVAL_MS, POLL_INTERVAL_MS, createRealtime, type WsMessage } from "./api";

// Under jsdom BASE is not localhost in these tests only if VITE_API_BASE_URL says
// so; force the polling strategy explicitly so the test is environment-independent.
const conn = (id: string, status: string) => ({ id, status });
const note = (id: string, type: string, related_id: string | null) => ({ id, type, related_id, body: "", title: "", read: false, user_id: "u", created_at: "" });
const msg = { id: "m1", connection_id: "c1", sender_id: "other", content: "Running late", kind: "free_text", created_at: "" };

let state: { connections: unknown[]; notifications: unknown[]; messages: unknown[] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_REALTIME_STRATEGY", "polling");
  state = { connections: [conn("c1", "pending")], notifications: [], messages: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url).replace(BASE, "");
    const body = path === "/me/connections" ? state.connections : path === "/notifications" ? state.notifications : state.messages;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function tick() { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); }

describe("polling real-time fallback", () => {
  it("emits connection_update when a connection's status changes", async () => {
    const events: WsMessage[] = [];
    const rt = createRealtime("u", e => events.push(e));
    await vi.advanceTimersByTimeAsync(0); // priming poll — no events for existing state
    expect(events).toEqual([]);

    state.connections = [conn("c1", "accepted")];
    await tick();
    expect(events).toEqual([{ type: "connection_update", connection_id: "c1", status: "accepted" }]);
    rt.close();
  });

  it("emits chat_message with the latest message when a new chat notification appears", async () => {
    const events: WsMessage[] = [];
    const rt = createRealtime("u", e => events.push(e));
    await vi.advanceTimersByTimeAsync(0);

    state.notifications = [note("n1", "chat_message", "c1")];
    state.messages = [msg];
    await tick();
    expect(events).toEqual([{ type: "chat_message", connection_id: "c1", message: msg }]);

    await tick(); // same notification again — no duplicate
    expect(events).toHaveLength(1);
    rt.close();
  });

  it("stops polling after close()", async () => {
    const events: WsMessage[] = [];
    const rt = createRealtime("u", e => events.push(e));
    await vi.advanceTimersByTimeAsync(0);
    rt.close();
    state.connections = [conn("c1", "accepted")];
    await tick();
    expect(events).toEqual([]);
  });
});

describe("adaptive polling", () => {
  it("polls faster while a connection is pending, slower once settled", async () => {
    const calls = () => (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).endsWith("/me/connections")).length;
    const stop = createRealtime("u", () => {}).close;
    await vi.advanceTimersByTimeAsync(0);
    const start = calls();
    await vi.advanceTimersByTimeAsync(PENDING_POLL_INTERVAL_MS * 2 + 10);
    expect(calls() - start).toBeGreaterThanOrEqual(2);
    state.connections = [conn("c1", "accepted")];
    await vi.advanceTimersByTimeAsync(PENDING_POLL_INTERVAL_MS + 10);
    const settled = calls();
    await vi.advanceTimersByTimeAsync(PENDING_POLL_INTERVAL_MS * 2);
    expect(calls()).toBe(settled);
    stop();
  });
});
