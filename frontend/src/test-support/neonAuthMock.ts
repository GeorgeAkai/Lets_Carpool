export type MockNeonSession = { user: { id: string; email: string; name?: string } } | null;

let session: MockNeonSession = null;
let listeners: Array<() => void> = [];

export function setMockNeonSession(next: MockNeonSession): void {
  session = next;
  listeners.forEach((listener) => listener());
}

export function getMockNeonSession(): MockNeonSession {
  return session;
}

export function subscribeMockNeonSession(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}
