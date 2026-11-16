import { beforeEach, describe, expect, it } from "vitest";
import { clearCache, readCache, writeCache } from "./cache";

describe("persistent cache", () => {
  beforeEach(() => localStorage.clear());

  it("returns what was stored, and null for anything missing or corrupt", () => {
    writeCache("usr_1:feed", [{ id: "a" }]);
    expect(readCache("usr_1:feed")).toEqual([{ id: "a" }]);
    expect(readCache("usr_1:nothing")).toBeNull();
    localStorage.setItem("carpool_cache:v1:bad", "{not json");
    expect(readCache("bad")).toBeNull();
  });

  it("clears only its own entries on sign-out", () => {
    writeCache("me", { id: "usr_1" });
    localStorage.setItem("carpool_token", "tok");
    clearCache();
    expect(readCache("me")).toBeNull();
    expect(localStorage.getItem("carpool_token")).toBe("tok");
  });
});
