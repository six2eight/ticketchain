import { useQuery } from "@tanstack/react-query";
import { Html5Qrcode } from "html5-qrcode";
import { useEffect, useRef, useState } from "react";

import { api, ApiError, type CheckinResult, type EventDto, type Page } from "../api";
import { RequireSession } from "../components/WalletBar";
import { short } from "../hooks";
import { useSession } from "../session";

const REASONS: Record<string, string> = {
  QR_MALFORMED: "Not a TicketChain QR code",
  QR_EXPIRED: "QR expired — ask the guest to refresh it",
  WRONG_EVENT: "Ticket is for a different event",
  NOT_STAFF: "You are not staff for this event",
  TICKET_NOT_FOUND: "Ticket not found",
  INVALID_SIGNATURE: "Invalid or revoked QR signature",
  OWNER_CHANGED: "Ticket was resold — old QR",
  QR_REPLAYED: "This exact QR was already scanned (screenshot?)",
  OUTSIDE_CHECKIN_WINDOW: "Check-in is not open for this event",
  ALREADY_USED: "Ticket already used",
};

export function ScannerPage() {
  return (
    <RequireSession>
      <Scanner />
    </RequireSession>
  );
}

function Scanner() {
  const { token } = useSession();
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => api<Page<EventDto>>("GET", "/events?limit=100"),
  });
  const [eventId, setEventId] = useState<number | null>(null);
  const [manual, setManual] = useState("");
  const [result, setResult] = useState<CheckinResult | { result: "ERROR"; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const scanner = useRef<Html5Qrcode | null>(null);
  const lastText = useRef<{ text: string; at: number } | null>(null);
  const eventRef = useRef<number | null>(null);
  eventRef.current = eventId;

  useEffect(() => {
    if (eventId === null && events.data?.items.length) setEventId(events.data.items.at(-1)!.id);
  }, [events.data, eventId]);

  async function verify(qr: string) {
    const id = eventRef.current;
    if (!id || !qr.trim()) return;
    setBusy(true);
    try {
      setResult(
        await api<CheckinResult>("POST", "/checkin", {
          token,
          body: { eventId: id, qr: qr.trim() },
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "NOT_STAFF")
        setResult({ result: "REJECTED", reason: "NOT_STAFF" });
      else
        setResult({ result: "ERROR", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function startCamera() {
    setCamera(true);
    await new Promise((r) => setTimeout(r, 0));
    const s = new Html5Qrcode("qr-reader");
    scanner.current = s;
    try {
      await s.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (text) => {
          // Ignore the same code for a few seconds while it is still in front of the camera.
          const last = lastText.current;
          if (last && last.text === text && Date.now() - last.at < 4000) return;
          lastText.current = { text, at: Date.now() };
          void verify(text);
        },
        () => undefined,
      );
    } catch (err) {
      setCamera(false);
      setResult({
        result: "ERROR",
        message: `Camera unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function stopCamera() {
    await scanner.current?.stop().catch(() => undefined);
    scanner.current = null;
    setCamera(false);
  }

  useEffect(() => () => void scanner.current?.stop().catch(() => undefined), []);

  return (
    <section className="scanner">
      <h1>Door scanner</h1>
      <label>
        Event
        <select
          className="select"
          value={eventId ?? ""}
          onChange={(e) => setEventId(Number(e.target.value))}
          aria-label="Event to scan"
        >
          {events.data?.items.map((e) => (
            <option key={e.id} value={e.id}>
              #{e.id} {e.name}
            </option>
          ))}
        </select>
      </label>

      <ScanResult result={result} />

      <div className="card">
        {camera ? (
          <>
            <div id="qr-reader" className="reader" />
            <button className="btn" onClick={() => void stopCamera()}>
              Stop camera
            </button>
          </>
        ) : (
          <button className="btn primary big" onClick={() => void startCamera()}>
            📷 Scan with camera
          </button>
        )}
      </div>

      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          void verify(manual);
        }}
      >
        <label>
          Or paste QR text
          <textarea
            className="input mono"
            rows={3}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            aria-label="QR text"
          />
        </label>
        <button className="btn" type="submit" disabled={busy || !manual.trim()}>
          {busy ? "Checking…" : "Verify"}
        </button>
      </form>
    </section>
  );
}

function ScanResult({
  result,
}: {
  result: CheckinResult | { result: "ERROR"; message: string } | null;
}) {
  if (!result) return <div className="scan-result idle">Ready to scan</div>;
  if (result.result === "ACCEPTED") {
    return (
      <div
        className="scan-result accepted"
        role="status"
        data-testid="scan-result"
        data-result="ACCEPTED"
      >
        <div className="big-icon">✅</div>
        <strong>ADMIT</strong>
        <span>
          Ticket #{result.tokenId} · {short(result.holder)}
        </span>
      </div>
    );
  }
  if (result.result === "ERROR") {
    return (
      <div
        className="scan-result rejected"
        role="alert"
        data-testid="scan-result"
        data-result="ERROR"
      >
        <div className="big-icon">⚠️</div>
        <strong>{result.message}</strong>
      </div>
    );
  }
  return (
    <div
      className="scan-result rejected"
      role="alert"
      data-testid="scan-result"
      data-result="REJECTED"
      data-reason={result.reason}
    >
      <div className="big-icon">❌</div>
      <strong>{REASONS[result.reason] ?? result.reason}</strong>
      <span className="mono small">{result.reason}</span>
    </div>
  );
}
