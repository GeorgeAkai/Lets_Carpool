import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IncomingRequests } from "./incoming-requests";
import type { Connection } from "./home";

const conn = (over: Partial<Connection>): Connection => ({
  id: "c1", withUser: { name: "Sam", initials: "S", photoUrl: null }, withUserId: "u2",
  initiatorUserId: "u2", myRole: "driver", route: "A ➔ B", from: "A", to: "B", date: "2030-01-01",
  status: "pending", splitConfirmed: false, unreadMessages: 0, driverTripId: "t", rideRequestId: "r",
  riderPickupLabel: "Elm St", riderPickupLat: 1, riderPickupLng: 2, ...over,
});

const props = () => ({
  currentUserId: "me", onAccept: vi.fn(async () => {}), onDecline: vi.fn(async () => {}),
  onStartDriving: vi.fn(), onOpenChat: vi.fn(), reload: vi.fn(async () => {}), showToast: vi.fn(),
});

describe("IncomingRequests", () => {
  it("shows the pickup and accepts in one tap, then offers navigation", async () => {
    const p = props();
    const pending = conn({});
    const { rerender } = render(<IncomingRequests connections={[pending]} {...p} />);
    expect(screen.getByText(/Elm St/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /accept/i }));
    expect(p.onAccept).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(p.reload).toHaveBeenCalled());

    rerender(<IncomingRequests connections={[{ ...pending, status: "accepted" }]} {...p} />);
    await userEvent.click(screen.getByRole("button", { name: /go to pickup/i }));
    expect(p.onStartDriving).toHaveBeenCalled();
  });

  it("ignores requests I started myself", () => {
    const { container } = render(<IncomingRequests connections={[conn({ initiatorUserId: "me" })]} {...props()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
