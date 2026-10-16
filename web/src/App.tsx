import { lazy, Suspense } from "react";

import { WalletBar } from "./components/WalletBar";
import { EventDetailPage, EventsPage } from "./pages/Events";
import { MarketPage } from "./pages/Market";
import { MyTicketsPage } from "./pages/MyTickets";
import { OrganizerPage } from "./pages/Organizer";
import { useRoute } from "./router";

// The camera scanner library is large; load it only on the scanner page.
const ScannerPage = lazy(() => import("./pages/Scanner").then((m) => ({ default: m.ScannerPage })));

const TABS = [
  ["events", "Events"],
  ["tickets", "My Tickets"],
  ["market", "Resale"],
  ["organizer", "Organizer"],
  ["scanner", "Scanner"],
] as const;

export function App() {
  const [page, id] = useRoute();
  return (
    <>
      <header className="header">
        <a className="brand" href="#/events">
          <span className="logo">TC</span> TicketChain
        </a>
        <nav aria-label="Main">
          {TABS.map(([path, label]) => (
            <a
              key={path}
              href={`#/${path}`}
              className={page === path ? "active" : ""}
              aria-current={page === path ? "page" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <WalletBar />
      </header>
      <main className="main">
        {page === "events" && id ? <EventDetailPage id={Number(id)} /> : null}
        {page === "events" && !id ? <EventsPage /> : null}
        {page === "tickets" && <MyTicketsPage />}
        {page === "market" && <MarketPage />}
        {page === "organizer" && <OrganizerPage />}
        {page === "scanner" && (
          <Suspense fallback={<p className="empty">Loading scanner…</p>}>
            <ScannerPage />
          </Suspense>
        )}
      </main>
      <footer className="footer muted small">
        NFT tickets · rotating signed QR · capped resale
      </footer>
    </>
  );
}
