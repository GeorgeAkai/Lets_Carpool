import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileListingCard } from "./discover-mobile";
import type { Listing } from "./home";

const base: Listing = {
  id: "l1", type: "driver", apiId: "l1", ownerId: "usr_other",
  user: { name: "Dee Driver", initials: "DD", verified: false },
  from: "Chico, CA", to: "Sacramento, CA", date: "2026-10-01", flexibility: "morning",
  seats: 3, seatsUsed: 1, tags: [], status: "open", postedAt: "1h ago",
};

describe("MobileListingCard", () => {
  it("asks to join a driver's listing", () => {
    render(<MobileListingCard listing={base} onConnect={vi.fn()} currentUserId="usr_me" onEditOwn={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Request Ride" })).toBeTruthy();
  });

  it("offers a ride on a passenger's request", () => {
    render(<MobileListingCard listing={{ ...base, type: "rider", passengers: 2, seats: undefined }} onConnect={vi.fn()} currentUserId="usr_me" onEditOwn={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Offer Ride" })).toBeTruthy();
  });

  it("badges the user's own listing instead of showing a CTA", () => {
    render(<MobileListingCard listing={{ ...base, ownerId: "usr_me" }} onConnect={vi.fn()} currentUserId="usr_me" onEditOwn={vi.fn()} />);
    expect(screen.getByRole("button", { name: /your listing/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /request ride|offer ride/i })).toBeNull();
  });
});
