import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useWalletClient } from "wagmi";

import { buildQr, deviceKeyTypedData } from "../../../src/checkin/qr";
import { api, type TicketDto } from "../api";
import { CHAIN_ID } from "../config";
import { errorText, useAppConfig } from "../hooks";
import { useSession } from "../session";

interface StoredKey {
  privateKey: `0x${string}`;
  owner: string;
  expiresAt: number;
}

const storageKey = (tokenId: number) => `tc.device.${CHAIN_ID}.${tokenId}`;

function loadKey(ticket: TicketDto): StoredKey | null {
  try {
    const k = JSON.parse(
      localStorage.getItem(storageKey(ticket.tokenId)) ?? "null",
    ) as StoredKey | null;
    if (!k || k.owner !== ticket.owner || k.expiresAt * 1000 <= Date.now()) return null;
    return k;
  } catch {
    return null;
  }
}

/**
 * Rotating check-in QR. A device key is generated in the browser and delegated once with an
 * EIP-712 signature; after that the QR is re-signed every TTL seconds without wallet popups.
 */
export function TicketQr({ ticket }: { ticket: TicketDto }) {
  const { data: cfg } = useAppConfig();
  const { data: walletClient } = useWalletClient();
  const session = useSession();
  const [key, setKey] = useState<StoredKey | null>(() => loadKey(ticket));
  const [qr, setQr] = useState<{ text: string; image: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function enable() {
    if (!walletClient || !cfg || !session.token) return;
    setBusy(true);
    setError(null);
    try {
      const privateKey = generatePrivateKey();
      const device = privateKeyToAccount(privateKey).address;
      const start = Math.floor(new Date(ticket.event?.startTime ?? Date.now()).getTime() / 1000);
      const expiresAt = Math.max(Math.floor(Date.now() / 1000) + 3600, start + 12 * 3600);
      const signature = await walletClient.signTypedData({
        account: walletClient.account,
        ...deviceKeyTypedData({
          chainId: cfg.chainId,
          contract: cfg.contractAddress,
          tokenId: ticket.tokenId,
          device,
          expiresAt,
        }),
      });
      await api("POST", `/tickets/${ticket.tokenId}/device-keys`, {
        token: session.token,
        body: { device, expiresAt, signature },
      });
      const stored = { privateKey, owner: ticket.owner, expiresAt };
      localStorage.setItem(storageKey(ticket.tokenId), JSON.stringify(stored));
      setKey(stored);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!key || !cfg) return;
    let cancelled = false;
    const device = privateKeyToAccount(key.privateKey);
    async function refresh() {
      const { text, payload } = await buildQr({
        signer: device,
        chainId: cfg!.chainId,
        contract: cfg!.contractAddress,
        tokenId: ticket.tokenId,
        eventId: ticket.eventId,
        ttlSeconds: cfg!.qrTtlSeconds,
      });
      const image = await QRCode.toDataURL(text, {
        margin: 1,
        width: 280,
        errorCorrectionLevel: "M",
      });
      if (!cancelled) setQr({ text, image, expiresAt: payload.x * 1000 });
    }
    void refresh();
    const rotate = setInterval(() => void refresh(), Math.max(5, cfg.qrTtlSeconds - 5) * 1000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(rotate);
      clearInterval(tick);
    };
  }, [key, cfg, ticket.tokenId, ticket.eventId]);

  if (!key) {
    return (
      <div className="qr-panel">
        <p className="muted small">
          Enable your door QR once with a wallet signature. It then refreshes every{" "}
          {cfg?.qrTtlSeconds ?? 30} s on this device.
        </p>
        <button
          className="btn primary"
          onClick={() => void enable()}
          disabled={busy || !walletClient}
        >
          {busy ? "Waiting for signature…" : "Enable QR (one signature)"}
        </button>
        {error && <p className="notice error">{error}</p>}
      </div>
    );
  }

  const secondsLeft = qr ? Math.max(0, Math.ceil((qr.expiresAt - now) / 1000)) : 0;
  return (
    <div className="qr-panel">
      {qr ? (
        <img
          src={qr.image}
          alt={`Check-in QR for ticket #${ticket.tokenId}`}
          className="qr"
          width={280}
          height={280}
        />
      ) : (
        <p>Generating…</p>
      )}
      <p className="muted small" aria-live="polite">
        Refreshes automatically · valid for {secondsLeft}s
      </p>
      <details>
        <summary className="small">QR text (for testing without a camera)</summary>
        <textarea
          readOnly
          className="mono"
          rows={3}
          value={qr?.text ?? ""}
          data-testid={`qr-text-${ticket.tokenId}`}
          onFocus={(e) => e.currentTarget.select()}
        />
      </details>
    </div>
  );
}
