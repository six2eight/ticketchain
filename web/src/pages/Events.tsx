import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";

import { api, type EventDto, type Page } from "../api";
import { TxStatus } from "../components/TxStatus";
import { eth, useContractTx, when } from "../hooks";
import { navigate } from "../router";

export function EventsPage() {
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Page<EventDto>>("GET", "/events?limit=100"),
    refetchInterval: 5000,
  });

  if (events.isPending) return <p className="empty">Loading events…</p>;
  if (events.isError)
    return <p className="notice error">Could not load events: {events.error.message}</p>;
  const items = [...events.data.items].reverse();
  if (items.length === 0) {
    return (
      <div className="empty">
        <p>No events yet.</p>
        <a className="btn" href="#/organizer">
          Host an event
        </a>
      </div>
    );
  }

  return (
    <section>
      <div className="row between">
        <h1>Events</h1>
        <a className="link small" href="#/organizer">
          Host an event →
        </a>
      </div>
      <div className="grid">
        {items.map((e) => (
          <article key={e.id} className="card event-card" data-testid={`event-${e.id}`}>
            <h2>{e.name}</h2>
            <p className="muted">{when(e.startTime)}</p>
            {e.venue && <p className="muted">📍 {e.venue}</p>}
            <p className="price">{eth(e.priceWei)}</p>
            <p className="muted small">
              {e.ticketsLeft} of {e.maxSupply} left
              {e.resaleEnabled ? ` · resale up to ${eth(e.resaleCapWei)}` : " · no resale"}
            </p>
            <button className="btn" onClick={() => navigate(`/events/${e.id}`)}>
              View
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

export function EventDetailPage({ id }: { id: number }) {
  const { isConnected } = useConnection();
  const event = useQuery({
    queryKey: ["event", id],
    queryFn: () => api<EventDto>("GET", `/events/${id}`),
    refetchInterval: 4000,
  });
  const tx = useContractTx();

  if (event.isPending) return <p className="empty">Loading…</p>;
  if (event.isError) return <p className="notice error">{event.error.message}</p>;
  const e = event.data;
  const started = new Date(e.startTime).getTime() <= Date.now();

  return (
    <section className="detail">
      <button className="link" onClick={() => navigate("/events")}>
        ← All events
      </button>
      <h1>{e.name}</h1>
      <p className="muted">
        {when(e.startTime)}
        {e.venue ? ` · ${e.venue}` : ""}
      </p>
      {e.description && <p>{e.description}</p>}
      <div className="card stats-row">
        <div>
          <span className="label">Price</span>
          <strong>{eth(e.priceWei)}</strong>
        </div>
        <div>
          <span className="label">Tickets left</span>
          <strong data-testid="tickets-left">{e.ticketsLeft}</strong>
        </div>
        <div>
          <span className="label">Resale cap</span>
          <strong>{e.resaleEnabled ? eth(e.resaleCapWei) : "Resale disabled"}</strong>
        </div>
      </div>
      <button
        className="btn primary big"
        disabled={!isConnected || e.ticketsLeft === 0 || started || tx.state.status === "pending"}
        onClick={() =>
          void tx
            .send("Buy ticket", "buyTicket", [BigInt(e.id)], BigInt(e.priceWei))
            .catch(() => undefined)
        }
      >
        {!isConnected
          ? "Connect a wallet to buy"
          : started
            ? "Sales closed"
            : e.ticketsLeft === 0
              ? "Sold out"
              : `Buy ticket · ${eth(e.priceWei)}`}
      </button>
      <TxStatus state={tx.state} />
      {tx.state.status === "done" && (
        <p>
          Your NFT ticket is minted.{" "}
          <button className="link" onClick={() => navigate("/tickets")}>
            Go to My Tickets →
          </button>
        </p>
      )}
    </section>
  );
}
