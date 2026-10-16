import { API_URL } from "./config";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  method: string,
  path: string,
  o: { token?: string | null; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? res.statusText);
  }
  return json as T;
}

export interface PublicConfig {
  chainId: number;
  contractAddress: `0x${string}`;
  qrTtlSeconds: number;
}

export interface EventDto {
  id: number;
  organizer: string;
  name: string;
  description: string | null;
  venue: string | null;
  priceWei: string;
  resaleCapWei: string;
  resaleEnabled: boolean;
  maxSupply: number;
  sold: number;
  ticketsLeft: number;
  startTime: string;
}

export interface TicketDto {
  tokenId: number;
  eventId: number;
  owner: string;
  status: "VALID" | "CHECKING_IN" | "USED";
  listedPriceWei: string | null;
  usedAt: string | null;
  imageUrl: string;
  event?: { name: string; startTime: string; venue: string | null };
}

export interface ListingDto {
  tokenId: number;
  eventId: number;
  seller: string;
  priceWei: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}

export type CheckinResult =
  | { result: "ACCEPTED"; tokenId: number; eventId: number; holder: string; txRequestId: number }
  | { result: "REJECTED"; reason: string; tokenId?: number; usedAt?: string | null };
