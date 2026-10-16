const escapeXml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  VALID: { label: "VALID", color: "#16a34a" },
  CHECKING_IN: { label: "CHECKED IN", color: "#d97706" },
  USED: { label: "USED", color: "#6b7280" },
};

export interface TicketArt {
  tokenId: number;
  eventName: string;
  venue?: string | null;
  startTime: Date;
  status: string;
}

/** Renders the ticket as a 600×300 SVG; used tickets get a diagonal "USED" stamp. */
export function renderTicketSvg(t: TicketArt): string {
  const style = STATUS_STYLE[t.status] ?? { label: t.status, color: "#6b7280" };
  const date = t.startTime.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const name = escapeXml(t.eventName.length > 34 ? `${t.eventName.slice(0, 33)}…` : t.eventName);
  const venue = t.venue ? escapeXml(t.venue.slice(0, 48)) : "";
  const used = t.status !== "VALID";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300" role="img" aria-label="${name} ticket #${t.tokenId} (${style.label})">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${used ? "#374151" : "#4f46e5"}"/>
      <stop offset="1" stop-color="${used ? "#111827" : "#9333ea"}"/>
    </linearGradient>
  </defs>
  <rect width="600" height="300" rx="24" fill="url(#bg)"/>
  <line x1="440" y1="20" x2="440" y2="280" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2" stroke-dasharray="6 8"/>
  <text x="36" y="64" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#e0e7ff" letter-spacing="3">TICKETCHAIN</text>
  <text x="36" y="118" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#ffffff">${name}</text>
  <text x="36" y="156" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#e0e7ff">${escapeXml(date)}</text>
  <text x="36" y="184" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#c7d2fe">${venue}</text>
  <rect x="36" y="222" width="${style.label.length * 13 + 32}" height="40" rx="20" fill="${style.color}"/>
  <text x="52" y="248" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="700" fill="#ffffff">${style.label}</text>
  <text x="520" y="140" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#e0e7ff">TICKET</text>
  <text x="520" y="180" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="36" font-weight="700" fill="#ffffff">#${t.tokenId}</text>
  ${used ? `<text x="300" y="190" text-anchor="middle" transform="rotate(-18 300 160)" font-family="Helvetica, Arial, sans-serif" font-size="96" font-weight="900" fill="none" stroke="#f87171" stroke-width="5" opacity="0.85">USED</text>` : ""}
</svg>`;
}
