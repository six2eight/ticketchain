import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api, type EventDto, type Page, type TicketDto } from "../api";
import { TicketQr } from "../components/TicketQr";
import { TxStatus } from "../components/TxStatus";
import { RequireSession } from "../components/WalletBar";
import { eth, toWei, useContractTx, when } from "../hooks";
import { useSession } from "../session";

export function MyTicketsPage() {
  return (
    <RequireSession>
      <Tickets />
    </RequireSession>
  );
}

function Tickets() {
  const { token } = useSession();
  const tickets = useQuery({
    queryKey: ["me", "tickets", token],
    queryFn: () => api<Page<TicketDto>>("GET", "/me/tickets?limit=100", { token }),
    refetchInterval: 3000,
  });
  if (tickets.isPending) return <p className="empty">Loading your tickets…</p>;
  if (tickets.isError) return <p className="notice error">{tickets.error.message}</p>;
  if (tickets.data.items.length === 0)
    return <p className="empty">You have no tickets yet. Buy one from the Events tab.</p>;
  return (
    <section>
      <h1>My tickets</h1>
      <div className="grid wide">
        {tickets.data.items.map((t) => (
          <TicketCard key={t.tokenId} ticket={t} />
        ))}
      </div>
    </section>
  );
}

const STATUS_TEXT: Record<TicketDto["status"], string> = {
  VALID: "Valid",
  CHECKING_IN: "Checked in",
  USED: "Used",
};

function TicketCard({ ticket }: { ticket: TicketDto }) {
  const [showQr, setShowQr] = useState(false);
  return (
    <article className="card ticket-card" data-testid={`ticket-${ticket.tokenId}`}>
      <img
        src={`${ticket.imageUrl}?s=${ticket.status}`}
        alt={`Ticket #${ticket.tokenId}`}
        className="ticket-art"
        loading="lazy"
      />
      <div className="row between">
        <div>
          <h2>{ticket.event?.name ?? `Event #${ticket.eventId}`}</h2>
          <p className="muted small">
            Ticket #{ticket.tokenId}
            {ticket.event ? ` · ${when(ticket.event.startTime)}` : ""}
          </p>
        </div>
        <span
          className={`badge ${ticket.status.toLowerCase()}`}
          data-testid={`status-${ticket.tokenId}`}
        >
          {STATUS_TEXT[ticket.status]}
        </span>
      </div>
      {ticket.status === "VALID" && (
        <>
          <button className="btn" onClick={() => setShowQr((v) => !v)}>
            {showQr ? "Hide QR" : "Show door QR"}
          </button>
          {showQr && <TicketQr ticket={ticket} />}
          <Resale ticket={ticket} />
        </>
      )}
    </article>
  );
}

function Resale({ ticket }: { ticket: TicketDto }) {
  const event = useQuery({
    queryKey: ["event", ticket.eventId],
    queryFn: () => api<EventDto>("GET", `/events/${ticket.eventId}`),
  });
  const tx = useContractTx();
  const [price, setPrice] = useState("");
  if (!event.data?.resaleEnabled) return null;
  const cap = event.data.resaleCapWei;

  if (ticket.listedPriceWei) {
    return (
      <div className="resale">
        <p className="small">
          Listed for resale at <strong>{eth(ticket.listedPriceWei)}</strong>
        </p>
        <button
          className="btn ghost"
          onClick={() =>
            void tx
              .send("Cancel listing", "cancelListing", [BigInt(ticket.tokenId)])
              .catch(() => undefined)
          }
          disabled={tx.state.status === "pending"}
        >
          Cancel listing
        </button>
        <TxStatus state={tx.state} />
      </div>
    );
  }

  let wei: bigint | null = null;
  try {
    wei = toWei(price || "0");
  } catch {
    wei = null;
  }
  const tooHigh = wei !== null && wei > BigInt(cap);
  return (
    <details className="resale">
      <summary className="small">Sell this ticket (max {eth(cap)})</summary>
      <div className="row">
        <input
          className="input"
          inputMode="decimal"
          placeholder="Price in ETH"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          aria-label="Resale price in ETH"
        />
        <button
          className="btn"
          disabled={wei === null || wei === 0n || tooHigh || tx.state.status === "pending"}
          onClick={() =>
            void tx
              .send("List for resale", "listForResale", [BigInt(ticket.tokenId), wei!])
              .catch(() => undefined)
          }
        >
          List
        </button>
      </div>
      {tooHigh && <p className="notice error small">Above the organizer's price cap.</p>}
      <TxStatus state={tx.state} />
    </details>
  );
}
