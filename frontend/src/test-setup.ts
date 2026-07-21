import "@testing-library/jest-dom";
import React from "react";
import { vi } from "vitest";

vi.mock("@neondatabase/neon-js/auth/react", async () => {
  const React = await import("react");
  const { createContext, useMemo, useState } = React;

  type MockSession = { user: { id: string; email: string; name?: string } } | null;

  let currentSession: MockSession = null;
  let triggerRender: (() => void) | null = null;

  const AuthUIContext = createContext({
    hooks: {
      useSession: () => ({ data: null, isPending: false }),
    },
  });

  function NeonAuthUIProvider({ children }: { children: React.ReactNode }) {
    const [, forceRender] = useState(0);

    React.useEffect(() => {
      triggerRender = () => forceRender((value) => value + 1);
      return () => {
        triggerRender = null;
      };
    }, []);

    const authValue = useMemo(() => ({
      hooks: {
        useSession: () => ({ data: currentSession, isPending: false }),
      },
    }), [currentSession]);

    return React.createElement(AuthUIContext.Provider, { value: authValue }, children);
  }

  function AuthView({ pathname }: { pathname?: string }) {
    const [name, setName] = React.useState("");
    const [email, setEmail] = React.useState("");

    const authenticate = () => {
      currentSession = {
        user: {
          id: "usr_test",
          email: email || "ada@example.com",
          name: name || email.split("@")[0] || "Ada Rider",
        },
      };
      triggerRender?.();
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
  createAuthClient: () => ({ signOut: vi.fn(async () => {}) }),
}));

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
