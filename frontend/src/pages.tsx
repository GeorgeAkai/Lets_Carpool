import { type ReactNode } from "react";
import { Text, View } from "react-native-web";

type PageProps = {
  title: string;
  description: string;
  children: ReactNode;
};

function PageLayout({ title, description, children }: PageProps) {
  return (
    <View style={{ padding: 20, overflow: "auto" }} accessibilityLabel={`${title} page`}>
      <Text style={{ fontSize: 28, fontWeight: "700", marginBottom: 12 }}>{title}</Text>
      <Text style={{ marginBottom: 20, color: "#444" }}>{description}</Text>
      {children}
    </View>
  );
}

export function HomePage() {
  return (
    <PageLayout
      title="Carpool MVP"
      description="A small two-sided marketplace for riders and drivers with the MVP flows described in the implementation guide."
    >
      <Text style={{ marginBottom: 10 }}>
        This app contains pages for the MVP issues: sign in, profile, locations, ride requests, driver trips, search, connections,
        chat, and gas split confirmation.
      </Text>
      <Text style={{ marginBottom: 12, fontWeight: "700" }}>Quick status</Text>
      <Text>- Frontend: web UI running at port 5173.</Text>
      <Text>- Backend: health endpoint available on port 8000.</Text>
      <Text>- Use the navigation buttons to open each page.</Text>
    </PageLayout>
  );
}

export function SignInPage() {
  return (
    <PageLayout
      title="Sign In"
      description="A front-door page for OAuth sign-in and first-time account creation in the MVP flow."
    >
      <Text style={{ marginBottom: 12 }}>What this page is for:</Text>
      <Text>- Start OAuth sign-in from the frontend.</Text>
      <Text>- First sign-in should create a user record and profile.</Text>
      <Text>- Repeat sign-in should fetch the existing account.</Text>
      <Text>- Verified email and email domain should be captured.</Text>
      <Text style={{ marginVertical: 12, fontWeight: "700" }}>Demo action</Text>
      <button
        type="button"
        onClick={() => alert("OAuth sign-in flow not wired yet.")}
        style={{
          backgroundColor: "#0070f3",
          padding: "12px",
          borderRadius: "8px",
          width: "180px",
          border: "none",
          color: "#fff",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Start OAuth Sign In
      </button>
    </PageLayout>
  );
}

export function ProfilePage() {
  return (
    <PageLayout
      title="Profile & Driver Readiness"
      description="Edit public profile details and self-declare driver readiness without document upload."
    >
      <Text>- Display name, profile photo, and short bio can be edited.</Text>
      <Text>- Vehicle details can be added or updated.</Text>
      <Text>- Self-declared license, insurance, and driving record fields are stored.</Text>
      <Text style={{ marginTop: 16, fontWeight: "700" }}>Driver readiness helps riders know which drivers are eligible to offer rides.</Text>
    </PageLayout>
  );
}

export function LocationPage() {
  return (
    <PageLayout
      title="Locations"
      description="Normalize geocoded locations so the app stores coordinates, labels, metadata, and provider IDs as first-class objects."
    >
      <Text>- Frontend can search addresses or places.
      </Text>
      <Text>- Backend stores latitude, longitude, display label, provider metadata, and timestamps.</Text>
      <Text>- Provider data is used only to normalize the app-owned location record.</Text>
      <Text>- Approximate labels are shown before acceptance; exact details are shown after acceptance.</Text>
    </PageLayout>
  );
}

export function RideRequestPage() {
  return (
    <PageLayout
      title="Publish Rider Request"
      description="Create and manage one-off ride requests with pickup/destination, timing, passenger count, and tags."
    >
      <Text>- Riders can create a ride request with pickup and destination locations.</Text>
      <Text>- Target date, flexibility, passenger count, and tags are captured.</Text>
      <Text>- Supported tags include airport and student.</Text>
      <Text>- Requests are created with open status and can be cancelled or expired.
      </Text>
    </PageLayout>
  );
}

export function DriverTripPage() {
  return (
    <PageLayout
      title="Publish Driver Trip"
      description="Create and manage driver trips with pickup/destination, timing, seats available, and tags."
    >
      <Text>- Drivers can create a trip with pickup and destination locations.</Text>
      <Text>- Target date, flexibility, seats available, and tags are captured.</Text>
      <Text>- Supported tags include airport and student.</Text>
      <Text>- Trips are created with open status and can be cancelled or expired.</Text>
    </PageLayout>
  );
}

export function SearchPage() {
  return (
    <PageLayout
      title="Search Opposite Listings"
      description="Search opposite-side listings with destination radius, pickup proximity, date flexibility, and tags."
    >
      <Text>- Riders discover open driver trips.</Text>
      <Text>- Drivers discover open ride requests.</Text>
      <Text>- Search supports destination radius, pickup proximity, date/flexibility, and airport/student tags.</Text>
      <Text>- Expired, cancelled, completed, or inactive listings are excluded.</Text>
    </PageLayout>
  );
}

export function ConnectionsPage() {
  return (
    <PageLayout
      title="Connections"
      description="Create and manage manual connections between ride requests and driver trips."
    >
      <Text>- Riders can request a seat on a driver trip.</Text>
      <Text>- Drivers can offer a ride on a ride request.</Text>
      <Text>- Connection states include pending, expired, accepted, declined, cancelled, and completed.</Text>
      <Text>- Recipients can accept or decline pending connections.</Text>
    </PageLayout>
  );
}

export function ChatPage() {
  return (
    <PageLayout
      title="Chat"
      description="Chat is unlocked by connection state: pending connections use canned messages, accepted connections allow full chat."
    >
      <Text>- Pending connections allow only canned or quick messages.</Text>
      <Text>- Accepted connections unlock full free-text chat.</Text>
      <Text>- Declined, expired, cancelled, or blocked connections do not continue normal chat.</Text>
      <Text style={{ marginTop: 16, fontWeight: "700" }}>This page explains the chat flow for the MVP.</Text>
    </PageLayout>
  );
}

export function GasSplitPage() {
  return (
    <PageLayout
      title="Gas Split Confirmation"
      description="Show a suggested gas split, allow edits or overrides, and record confirmation while keeping payment outside the app."
    >
      <Text>- Displays a suggested split based on estimated distance and cost assumptions.</Text>
      <Text>- Participants can override the suggested amount.</Text>
      <Text>- Confirmation records amount, confirmer, timestamp, and assumptions metadata.</Text>
      <Text>- Payment is handled outside the product in MVP.</Text>
    </PageLayout>
  );
}
