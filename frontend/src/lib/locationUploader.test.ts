import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocationUploader } from "./locationUploader";

describe("createLocationUploader", () => {
  beforeEach(() => { vi.useFakeTimers() });
  afterEach(() => { vi.useRealTimers() });

  const at = (lat: number) => ({ lat, lng: -100 });

  it("sends the first fix immediately, then at most one per interval, newest only", async () => {
    const send = vi.fn(async () => {});
    const u = createLocationUploader(send, () => Date.now());
    u.push(at(40));
    expect(send).toHaveBeenCalledTimes(1);
    // A burst of fixes inside the interval collapses to the latest one.
    u.push(at(40.001)); u.push(at(40.002)); u.push(at(40.003));
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2600);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(at(40.003));
  });

  it("skips tiny moves but sends a heartbeat", async () => {
    const send = vi.fn(async () => {});
    const u = createLocationUploader(send, () => Date.now());
    u.push(at(40));
    await vi.advanceTimersByTimeAsync(3000);
    u.push(at(40.00001)) // ~1 m
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(13_000);
    u.push(at(40.00001));
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never overlaps requests", async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<void>(r => { release = r }));
    const u = createLocationUploader(send, () => Date.now());
    u.push(at(40));
    u.push(at(40.01));
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1); // first still in flight
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
