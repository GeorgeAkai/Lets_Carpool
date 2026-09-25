import "@testing-library/jest-dom";
import React from "react";
import { beforeEach, vi } from "vitest";
import { setMockNeonSession } from "./test-support/neonAuthMock";

// The mock session is a module-level singleton (see test-support/neonAuthMock.ts)
// so it survives across tests unless explicitly reset — without this, a session
// set by one test leaks into the next and causes order-dependent failures.
// sessionStorage (e.g. carpool_mode) is real jsdom state shared across tests in
// this file for the same reason, so it gets the same treatment.
beforeEach(() => {
  setMockNeonSession(null);
  sessionStorage.clear();
});

vi.mock("@neondatabase/neon-js/auth/react", async () => {
  const React = await import("react");
  const { createContext, useSyncExternalStore } = React;
  const { useNavigate } = await import("react-router-dom");
  const { getMockNeonSession, setMockNeonSession, subscribeMockNeonSession } = await import(
    "./test-support/neonAuthMock"
  );
  type MockNeonSession = ReturnType<typeof getMockNeonSession>;

  const AuthUIContext = createContext<{ hooks: { useSession: () => { data: MockNeonSession; isPending: boolean } } }>({
    hooks: {
      useSession: () => ({ data: null, isPending: false }),
    },
  });

  function NeonAuthUIProvider({ children }: { children: React.ReactNode }) {
    const session = useSyncExternalStore(subscribeMockNeonSession, getMockNeonSession);

    const authValue = React.useMemo(() => ({
      hooks: {
        useSession: () => ({ data: session, isPending: false }),
      },
    }), [session]);

    return React.createElement(AuthUIContext.Provider, { value: authValue }, children);
  }

  function AuthView({ pathname }: { pathname?: string }) {
    const navigate = useNavigate();
    const [name, setName] = React.useState("");
    const [email, setEmail] = React.useState("");

    const authenticate = () => {
      setMockNeonSession({
        user: {
          id: "usr_test",
          email: email || "ada@example.com",
          name: name || email.split("@")[0] || "Ada Rider",
        },
      });
      // Real Neon Auth UI redirects back to the app after sign-in; Home (and
      // NeonAuthSync, which syncs the session to the backend) only lives at "/".
      navigate("/", { replace: true });
    };

    const handleSubmit = (event: React.FormEvent) => {
      event.preventDefault();
      authenticate();
    };

    return React.createElement(
      "form",
      { className: "grid w-full gap-6", onSubmit: handleSubmit },
      React.createElement("input", {
        placeholder: "Ada Rider",
        value: name,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        "aria-label": "Name",
      }),
      React.createElement("input", {
        placeholder: "you@example.com",
        value: email,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setEmail(event.target.value),
        "aria-label": "Email",
      }),
      React.createElement("button", { type: "submit" }, "Sign in / Sign up")
    );
  }

  return {
    NeonAuthUIProvider,
    AuthView,
    AuthUIContext,
  };
});

vi.mock("@neondatabase/neon-js/auth", () => ({
  createAuthClient: () => ({
    signOut: vi.fn(async () => {}),
  }),
}));

// fetchNeonJWT (src/lib/auth.ts) does a real fetch to the Neon Auth server's
// /token endpoint — mocked here so tests don't depend on network access, and
// so individual test files don't each need to know about this implementation
// detail of the auth sync flow.
vi.mock("./lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/auth")>();
  return {
    ...actual,
    authClient: { signOut: vi.fn(async () => {}) },
    fetchNeonJWT: vi.fn(async () => "mock.neon.jwt"),
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
