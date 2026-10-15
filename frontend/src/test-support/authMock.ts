export type MockAuthSession = { user: { id: string; email: string; name?: string } } | null;

let session: MockAuthSession = null;
let listeners: Array<() => void> = [];

export function setMockAuthSession(next: MockAuthSession): void {
  session = next;
  listeners.forEach((listener) => listener());
}

export function getMockAuthSession(): MockAuthSession {
  return session;
}

export function subscribeMockAuthSession(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}
