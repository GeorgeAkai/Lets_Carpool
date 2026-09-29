import "@testing-library/jest-dom";
import React from "react";
import { beforeEach, vi } from "vitest";
import { setMockAuthUser } from "./test-support/authMock";

// The mock session is a module-level singleton (see test-support/authMock.ts)
// so it survives across tests unless explicitly reset — without this, a session
// set by one test leaks into the next and causes order-dependent failures.
// sessionStorage (e.g. carpool_mode) is real jsdom state shared across tests in
// this file for the same reason, so it gets the same treatment.
beforeEach(() => {
  setMockAuthUser(null);
  sessionStorage.clear();
});

// lib/auth.ts wraps supabase-js; tests swap it for the in-memory session above
// so no test needs network access or a Supabase project. getAccessToken is a
// vi.fn so individual tests can make it fail.
vi.mock("./lib/auth", async () => {
  const React = await import("react");
  const { getMockAuthUser, setMockAuthUser, subscribeMockAuthUser } = await import("./test-support/authMock");
  return {
    supabase: null,
    isAuthConfigured: true,
    useAuthSession: () => ({
      user: React.useSyncExternalStore(subscribeMockAuthUser, getMockAuthUser),
      isPending: false,
    }),
    getAccessToken: vi.fn(async () => "mock.supabase.jwt"),
    signIn: vi.fn(async (email: string) => { setMockAuthUser({ id: "usr_test", email }); }),
    signUp: vi.fn(async (_name: string, email: string) => {
      setMockAuthUser({ id: "usr_test", email });
      return { needsConfirmation: false };
    }),
    sendPasswordReset: vi.fn(async () => {}),
    updatePassword: vi.fn(async () => {}),
    signOut: vi.fn(async () => { setMockAuthUser(null); }),
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
