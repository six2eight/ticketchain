import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { isAddress } from "viem";
import { useConnection } from "wagmi";

import { api, type EventDto, type Page } from "../api";
import { TxStatus } from "../components/TxStatus";
import { RequireSession } from "../components/WalletBar";
import { Withdraw } from "../components/Withdraw";
import { eth, short, toWei, useContractTx, when } from "../hooks";
import { useSession } from "../session";

const pad = (n: number) => String(n).padStart(2, "0");
function localInputValue(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function OrganizerPage() {
  return (
    <RequireSession>
      <section>
        <h1>Organizer</h1>
        <CreateEvent />
        <Withdraw label="Revenue ready to withdraw" />
        <MyEvents />
      </section>
    </RequireSession>
  );
}

function CreateEvent() {
  const tx = useContractTx();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("0.01");
  const [cap, setCap] = useState("0.015");
  const [supply, setSupply] = useState("100");
  const [start, setStart] = useState(() => localInputValue(new Date(Date.now() + 2 * 3600_000)));
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const startTime = BigInt(Math.floor(new Date(start).getTime() / 1000));
      const priceWei = toWei(price);
      const capWei = cap.trim() === "" ? 0n : toWei(cap);
      if (capWei !== 0n && capWei < priceWei)
        throw new Error("Resale cap must be 0 (disabled) or at least the price");
      void tx
        .send("Create event", "createEvent", [
          name.trim(),
          priceWei,
          Number(supply),
          startTime,
          capWei,
        ])
        .catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form className="card form" onSubmit={submit} aria-label="Create event">
      <h2>Create an event</h2>
      <label>
        Name
        <input
          className="input"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Dhaka Tech Fest 2026"
        />
      </label>
      <div className="row">
        <label>
          Price (ETH)
          <input
            className="input"
            required
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label>
          Resale cap (ETH, empty = no resale)
          <input
            className="input"
            inputMode="decimal"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
      </div>
      <div className="row">
        <label>
          Tickets
          <input
            className="input"
            required
            type="number"
            min={1}
            value={supply}
            onChange={(e) => setSupply(e.target.value)}
          />
        </label>
        <label>
          Starts at
          <input
            className="input"
            required
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
      </div>
      <button className="btn primary" type="submit" disabled={tx.state.status === "pending"}>
        Create event (wallet tx)
      </button>
      {error && <p className="notice error">{error}</p>}
      <TxStatus state={tx.state} />
    </form>
  );
}

function MyEvents() {
  const { address } = useConnection();
  const events = useQuery({
    queryKey: ["events", "mine", address],
    queryFn: () => api<Page<EventDto>>("GET", `/events?organizer=${address}&limit=100`),
    refetchInterval: 4000,
  });
  if (!events.data) return null;
  if (events.data.items.length === 0)
    return <p className="empty">You have not created any events yet.</p>;
  return (
    <>
      <h2>My events</h2>
      {[...events.data.items].reverse().map((e) => (
        <ManageEvent key={e.id} event={e} />
      ))}
    </>
  );
}

interface Stats {
  sold: number;
  revenueWei: string;
  checkedIn: number;
  checkingIn: number;
  listedForResale: number;
  attempts: { accepted: number; rejected: Record<string, number> };
}

function ManageEvent({ event }: { event: EventDto }) {
  const { token } = useSession();
  const stats = useQuery({
    queryKey: ["stats", event.id],
    queryFn: () => api<Stats>("GET", `/events/${event.id}/stats`, { token }),
    refetchInterval: 4000,
  });
  const staff = useQuery({
    queryKey: ["staff", event.id],
    queryFn: () => api<{ items: string[] }>("GET", `/events/${event.id}/staff`, { token }),
    refetchInterval: 4000,
  });
  const tx = useContractTx();
  const [wallet, setWallet] = useState("");
  const [venue, setVenue] = useState(event.venue ?? "");
  const [description, setDescription] = useState(event.description ?? "");
  const [saved, setSaved] = useState<string | null>(null);

  async function saveDetails() {
    setSaved(null);
    try {
      await api("PATCH", `/events/${event.id}`, {
        token,
        body: { venue: venue || null, description: description || null },
      });
      setSaved("Saved");
    } catch (err) {
      setSaved(err instanceof Error ? err.message : String(err));
    }
  }

  const s = stats.data;
  return (
    <article className="card manage" data-testid={`manage-${event.id}`}>
      <div className="row between">
        <div>
          <h3>
            #{event.id} {event.name}
          </h3>
          <p className="muted small">{when(event.startTime)}</p>
        </div>
      </div>
      {s && (
        <div className="stats-row">
          <div>
            <span className="label">Sold</span>
            <strong data-testid={`sold-${event.id}`}>
              {s.sold}/{event.maxSupply}
            </strong>
          </div>
          <div>
            <span className="label">Revenue</span>
            <strong>{eth(s.revenueWei)}</strong>
          </div>
          <div>
            <span className="label">Checked in</span>
            <strong data-testid={`checked-in-${event.id}`}>{s.checkedIn + s.checkingIn}</strong>
          </div>
          <div>
            <span className="label">Rejected scans</span>
            <strong>{Object.values(s.attempts.rejected).reduce((a, b) => a + b, 0)}</strong>
          </div>
        </div>
      )}

      <h4>Staff</h4>
      <ul className="list">
        {staff.data?.items.map((w) => (
          <li key={w} className="row between">
            <code title={w}>{short(w)}</code>
            <button
              className="btn ghost small"
              onClick={() =>
                void tx
                  .send("Remove staff", "removeStaff", [BigInt(event.id), w])
                  .catch(() => undefined)
              }
            >
              Remove
            </button>
          </li>
        ))}
        {staff.data?.items.length === 0 && <li className="muted small">No staff yet.</li>}
      </ul>
      <div className="row">
        <input
          className="input"
          placeholder="Staff wallet 0x…"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          aria-label={`Staff wallet for event ${event.id}`}
        />
        <button
          className="btn"
          disabled={!isAddress(wallet) || tx.state.status === "pending"}
          onClick={() =>
            void tx
              .send("Add staff", "addStaff", [BigInt(event.id), wallet])
              .then(() => setWallet(""))
              .catch(() => undefined)
          }
        >
          Add staff
        </button>
      </div>
      <TxStatus state={tx.state} />

      <details>
        <summary>Off-chain details</summary>
        <label>
          Venue
          <input className="input" value={venue} onChange={(e) => setVenue(e.target.value)} />
        </label>
        <label>
          Description
          <textarea
            className="input"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <button className="btn" onClick={() => void saveDetails()}>
          Save details
        </button>
        {saved && <span className="small muted"> {saved}</span>}
      </details>
    </article>
  );
}
