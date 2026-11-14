import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingRequestsView } from "./pending-requests";
import type { Connection, MyListing } from "./home";

const conn = (over: Partial<Connection>): Connection => ({
  id: "c1", withUser: { name: "Sam", initials: "S", photoUrl: null }, withUserId: "u2",
  initiatorUserId: "u2", myRole: "driver", route: "A ➔ B", from: "A", to: "B", date: "2030-01-01",
  status: "pending", splitConfirmed: false, unreadMessages: 0, driverTripId: "t1", rideRequestId: "r1",
  riderPickupLabel: "Elm St", ...over,
});
const trip = (id: string, over: Partial<MyListing> = {}): MyListing => ({
  id, type: "driver", from: "A", to: "B", date: "2030-01-01", flexibility: "flexible",
  seats: 3, seatsReserved: 1, tags: [], status: "open", createdAt: "", ...over,
});
const props = () => ({
  currentUserId: "me", tripId: null, onSelectTrip: vi.fn(), onAccept: vi.fn(async () => {}),
  onDecline: vi.fn(async () => {}), onOpenChat: vi.fn(), onStartDriving: vi.fn(), onOpenTripDay: vi.fn(), reload: vi.fn(async () => {}), showToast: vi.fn(),
});

describe("PendingRequestsView", () => {
  it("lists passenger requests grouped by trip and accepts one", async () => {
    const p = props();
    render(<PendingRequestsView {...p} trips={[trip("t1"), trip("t2", { to: "C" })]} connections={[
      conn({}), conn({ id: "c2", driverTripId: "t2", to: "C", withUser: { name: "Alex", initials: "A", photoUrl: null } }),
    ]} />);
    expect(screen.getAllByRole("region")).toHaveLength(2);
    expect(screen.getAllByText("2 seats free")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /accept sam/i }));
    expect(p.onAccept).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(p.reload).toHaveBeenCalled());
  });

  it("keeps an accepted passenger on the page with next steps", async () => {
    const p = props();
    const pending = conn({ riderPickupLat: 1, riderPickupLng: 2 });
    const { rerender } = render(<PendingRequestsView {...p} trips={[trip("t1")]} connections={[pending]} />);
    await userEvent.click(screen.getByRole("button", { name: /accept sam/i }));
    rerender(<PendingRequestsView {...p} trips={[trip("t1")]} connections={[{ ...pending, status: "accepted" }]} />);
    await userEvent.click(screen.getByRole("button", { name: /start trip/i }));
    expect(p.onStartDriving).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /trip day/i }));
    expect(p.onOpenTripDay).toHaveBeenCalled();
  });

  it("only shows the chosen trip, and ignores offers the driver started and non-pending ones", () => {
    render(<PendingRequestsView {...props()} tripId="t1" trips={[trip("t1"), trip("t2")]} connections={[
      conn({}),
      conn({ id: "c2", driverTripId: "t2" }),
      conn({ id: "c3", initiatorUserId: "me" }),
      conn({ id: "c4", status: "accepted" }),
    ]} />);
    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(1);
    expect(within(regions[0]).getAllByRole("button", { name: /^accept/i })).toHaveLength(1);
  });

  it("shows an empty state", () => {
    render(<PendingRequestsView {...props()} trips={[]} connections={[]} />);
    expect(screen.getByText(/no pending requests/i)).toBeInTheDocument();
  });
});
