import "@testing-library/jest-dom";
import React from "react";
import { beforeEach, vi } from "vitest";
import { setMockAuthSession } from "./test-support/authMock";

// The mock session is a module-level singleton (see test-support/authMock.ts)
// so it survives across tests unless explicitly reset — without this, a session
// set by one test leaks into the next and causes order-dependent failures.
// sessionStorage (e.g. carpool_mode) is real jsdom state shared across tests in
// this file for the same reason, so it gets the same treatment.
beforeEach(() => {
  setMockAuthSession(null);
  sessionStorage.clear();
});

// lib/auth.ts talks to Supabase; swap it for an in-memory session so tests
// control sign-in state directly and never touch the network.
vi.mock("./lib/auth", async () => {
  const { useSyncExternalStore } = await import("react");
  const { getMockAuthSession, setMockAuthSession, subscribeMockAuthSession } = await import(
    "./test-support/authMock"
  );

  const signedIn = (email: string, name?: string) =>
    setMockAuthSession({ user: { id: "usr_test", email: email || "ada@example.com", name } });

  return {
    useAuthSession: () => ({
      session: useSyncExternalStore(subscribeMockAuthSession, getMockAuthSession),
      isPending: false,
    }),
    getAccessToken: vi.fn(async () => "mock.supabase.jwt"),
    supabase: {
      auth: {
        signInWithPassword: vi.fn(async ({ email }: { email: string }) => {
          signedIn(email); return { data: {}, error: null };
        }),
        signUp: vi.fn(async ({ email, options }: { email: string; options?: { data?: { name?: string } } }) => {
          signedIn(email, options?.data?.name); return { data: { session: {} }, error: null };
        }),
        resetPasswordForEmail: vi.fn(async () => ({ error: null })),
        updateUser: vi.fn(async () => ({ error: null })),
        signOut: vi.fn(async () => { setMockAuthSession(null); return { error: null }; }),
      },
    },
  };
});

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  get length(): number { return this.store.size; }
}

Object.defineProperty(window, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// jsdom doesn't implement scrollIntoView at all — several chat/auto-scroll
// call sites use it as a fire-and-forget UX nicety (msgEndRef.current?.scrollIntoView(...)).
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
