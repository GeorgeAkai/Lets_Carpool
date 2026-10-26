import { describe, expect, it, beforeEach } from "vitest";
import { isMuted, playSound, setMuted, soundForNotification } from "./sounds";

describe("notification sounds", () => {
  beforeEach(() => { localStorage.clear(); setMuted(false); });

  it("maps backend notification types to tones", () => {
    expect(soundForNotification("connection_received")).toBe("request");
    expect(soundForNotification("connection_accepted")).toBe("accepted");
    expect(soundForNotification("ride_started")).toBe("driving");
    expect(soundForNotification("chat_message")).toBe("message");
    expect(soundForNotification("payment_processed")).toBe("paid");
    expect(soundForNotification("something_else")).toBeNull();
  });

  it("remembers the mute preference and never throws without Web Audio", () => {
    setMuted(true);
    expect(isMuted()).toBe(true);
    expect(localStorage.getItem("carpool_sound_muted")).toBe("1");
    expect(() => playSound("accepted")).not.toThrow();
    setMuted(false);
    expect(() => playSound("accepted")).not.toThrow();
  });
});
