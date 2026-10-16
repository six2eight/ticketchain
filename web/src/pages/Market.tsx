import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";

import { api, type EventDto, type ListingDto, type Page } from "../api";
import { TxStatus } from "../components/TxStatus";
import { eth, short, useContractTx } from "../hooks";

export function MarketPage() {
  const listings = useQuery({
    queryKey: ["listings"],
    queryFn: () => api<Page<ListingDto>>("GET", "/listings?limit=100"),
    refetchInterval: 4000,
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Page<EventDto>>("GET", "/events?limit=100"),
  });
  if (listings.isPending) return <p className="empty">Loading listings…</p>;
  if (listings.isError) return <p className="notice error">{listings.error.message}</p>;
  const name = (id: number) => events.data?.items.find((e) => e.id === id)?.name ?? `Event #${id}`;

  return (
    <section>
      <h1>Resale market</h1>
      <p className="muted">Resale prices are capped by the organizer on-chain — no scalping.</p>
      {listings.data.items.length === 0 ? (
        <p className="empty">No tickets listed right now.</p>
      ) : (
        <div className="grid">
          {listings.data.items.map((l) => (
            <ListingCard key={l.tokenId} listing={l} eventName={name(l.eventId)} />
          ))}
        </div>
      )}
    </section>
  );
}

function ListingCard({ listing, eventName }: { listing: ListingDto; eventName: string }) {
  const { address } = useConnection();
  const tx = useContractTx();
  const mine = address?.toLowerCase() === listing.seller;
  return (
    <article className="card" data-testid={`listing-${listing.tokenId}`}>
      <h2>{eventName}</h2>
      <p className="muted small">
        Ticket #{listing.tokenId} · seller {short(listing.seller)}
      </p>
      <p className="price">{eth(listing.priceWei)}</p>
      <button
        className="btn primary"
        disabled={!address || mine || tx.state.status === "pending" || tx.state.status === "done"}
        onClick={() =>
          void tx
            .send(
              "Buy resale ticket",
              "buyResale",
              [BigInt(listing.tokenId)],
              BigInt(listing.priceWei),
            )
            .catch(() => undefined)
        }
      >
        {mine ? "Your listing" : !address ? "Connect to buy" : "Buy"}
      </button>
      <TxStatus state={tx.state} />
    </article>
  );
}
