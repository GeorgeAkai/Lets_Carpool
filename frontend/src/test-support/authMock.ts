// In-memory stand-in for the Supabase session that lib/auth.ts exposes, so
// tests can start signed in/out and the real sign-in form can "sign in"
// without a network call. A module-level singleton, reset in test-setup.ts.
export type MockAuthUser = { id: string; email: string } | null;

let user: MockAuthUser = null;
let listeners: Array<() => void> = [];

export function setMockAuthUser(next: MockAuthUser): void {
  user = next;
  listeners.forEach((listener) => listener());
}

export function getMockAuthUser(): MockAuthUser {
  return user;
}

export function subscribeMockAuthUser(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}
