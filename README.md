# TicketChain

NFT event tickets with fraud-proof QR check-in, backed by a Web3 backend.

Organizers create events and sell tickets that are minted as NFTs. Buyers keep tickets in their wallet and show a **rotating QR code** at the door. Staff scan it, and the backend answers in milliseconds whether the ticket is valid. The ticket is then marked **used on-chain** through a backend relayer, so it can never be used or resold as unused again.

## Features

- **ERC-721 tickets** (`contracts/TicketChain.sol`, OpenZeppelin v5). Pull payments, reentrancy-safe withdrawals.
- **Anti-scalping resale:** tickets can only move through `buyResale`, which enforces the organizer's price cap. A direct `transferFrom` reverts.
- **Rotating QR codes:** the buyer delegates a *device key* once (one EIP-712 signature). After that, the QR is re-signed every 30 s with no wallet popups.
- **Check-in:** ten checks run in order (§9.3 of `PLAN.md`), ending with an atomic database lock. There are no chain calls on the hot path, and 10 parallel scans of one ticket admit it exactly once.
- **Indexer:** confirmations, reorg detection with rollback and replay, adaptive batch size, and resume after a restart.
- **Relayer:** idempotent queue, nonce manager, fee bumping for stuck transactions (same nonce, +12.5 %, capped), and resume after a restart without losing or duplicating transactions.
- **API:** Fastify, Zod validation, Swagger UI at `/docs`, Sign-In With Ethereum (SIWE) → JWT, rate limits, request IDs, and a consistent error format.
- **Web UI** (`web/`): React, wagmi and viem. Events, buying, My Tickets with a live QR, resale market, organizer dashboard, and a staff scanner (camera or pasted text).
- **No Docker.** Everything runs with npm scripts on Windows, macOS and Linux.

## Architecture

```
 Buyer / Organizer / Staff  (web UI, Swagger, scripts)
                 │  HTTPS + JWT
          ┌──────▼───────┐
          │  Fastify API │  zod validation, SIWE auth, Swagger
          └──┬────────┬──┘
   ┌─────────▼──┐   ┌─▼──────────────┐ logs ┌──────────────────┐
   │  SQLite    │◄──┤ Indexer        │◄─────┤  TicketChain.sol │
   │  (Prisma)  │   ├────────────────┤ txs  │  (Hardhat node / │
   │            │◄──┤ Relayer        ├─────►│   Sepolia)       │
   │            │◄──┤ Jobs           │      └──────────────────┘
   └────────────┘   └────────────────┘
```

Everything runs in one Node process (`src/main.ts`) with graceful shutdown. The blockchain is the source of truth, and the database is a fast mirror of it. The exception is data that only exists off-chain: event descriptions, device keys, scan attempts and relayer transactions.

The indexer, relayer and check-in service depend on the interfaces in `src/chain/ports.ts`, never on viem directly. That is why they are unit-tested against in-memory fake chains.

## Setup

Requirements: **Node.js 22+**. Nothing else.

```bash
npm install
cp .env.example .env
npm run setup          # compile contracts, export ABI, generate Prisma client, migrate DB
```

## Run it

```bash
npm run dev:all        # local Hardhat chain + deploy + backend (http://localhost:3000)
npm run seed           # in a 2nd terminal: demo event, staff, 3 buyers, 1 resale listing
npm run demo           # scripted walkthrough with ✅ / ❌ output
npm run web:dev        # optional web UI at http://localhost:5173
```

- Swagger UI: <http://localhost:3000/docs>
- Health: <http://localhost:3000/health>
- In the web UI, pick a **dev wallet** (Hardhat accounts, no MetaMask needed), or use MetaMask on the Hardhat network (chain 31337, RPC `http://127.0.0.1:8545`).

Restarting `npm run dev:all` resets the local chain. The backend detects this (contract address change or reorg back to genesis) and re-indexes from scratch automatically.

If port 3000 is taken, set `PORT` and `PUBLIC_BASE_URL` (and `API_URL` for the demo, `VITE_API_URL` for the web UI).

### Demo walkthrough (`npm run demo`)

1. Backend health
2. SIWE login for a buyer and a staff member
3. List events, then my tickets
4. Register a device key (one wallet signature)
5. Scan the QR: ✅ `ACCEPTED`
6. Replay the same QR (a screenshot): ❌ `QR_REPLAYED`
7. The relayer marks the ticket used: `USED` in the DB and `used(id) == true` on-chain
8. Rescan with a fresh QR: ❌ `ALREADY_USED`
9. Expired QR: ❌ `QR_EXPIRED`
10. Resale, then the seller's old QR: ❌ `OWNER_CHANGED`
11. `/health`

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Compile, export ABI, generate Prisma client, apply migrations |
| `npm run chain` | Local Hardhat node |
| `npm run deploy:local` | Deploy, grant `RELAYER_ROLE` to account #1, write `deployments/localhost.json` |
| `npm run dev` / `npm start` | Backend (watch mode / plain) |
| `npm run dev:all` | Chain + deploy + backend |
| `npm run seed` / `npm run demo` | Demo data / scripted demo |
| `npm run web:dev` / `npm run web:build` | Web UI dev server / production build |
| `npm test` | Contract, unit, API and e2e tests |
| `npm run test:contracts` | Hardhat tests (node:test + viem) |
| `npm run test:unit` | Indexer, relayer, QR, check-in (fake chains) |
| `npm run test:api` | Every route via `fastify.inject` |
| `npm run test:e2e` | Real Hardhat node + backend: buy → check-in → used, resale, reorg, restart |
| `npm run test:web` | Playwright browser tests of the web UI (desktop + mobile) |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run db:reset` | Drop and recreate the local DB |

## API

All responses are JSON. Errors look like `{ "error": { "code", "message" } }`. Wei amounts are decimal strings. Lists use `?limit=20&cursor=<id>` and return `{ items, nextCursor }`.

| Method & path | Auth | Description |
|---|---|---|
| `POST /auth/nonce` | — | SIWE message + nonce (body `{ address }`) |
| `POST /auth/verify` | — | Verify signature, returns a JWT (24 h) |
| `GET /events` | — | List (`upcoming=true`, `organizer=`) |
| `GET /events/:id` | — | Details + tickets left |
| `PATCH /events/:id` | organizer | Off-chain `description`, `venue` |
| `GET /events/:id/stats` | organizer | Sold, revenue, checked in, rejected scans by reason |
| `GET /events/:id/staff` | organizer | Staff wallets |
| `GET /me/tickets` | auth | My tickets with status |
| `GET /tickets/:tokenId` | — | Ticket + transfer history |
| `GET /tickets/:tokenId/device-key-typed-data` | owner | EIP-712 data to sign |
| `POST /tickets/:tokenId/device-keys` | owner | Register a device key |
| `GET /tickets/:tokenId/device-keys` | owner | My device keys |
| `DELETE /tickets/:tokenId/device-keys/:id` | owner | Revoke |
| `GET /tickets/:tokenId/qr-preview` | owner | Dev aid: unsigned payload + message |
| `GET /listings` | — | Resale listings (`eventId=`) |
| `POST /checkin` | staff | Verify a QR → `ACCEPTED` / `REJECTED` + reason |
| `GET /checkin/attempts` | organizer | Scan log |
| `GET /tx/:id` | organizer/staff | Relayer tx status + attempts |
| `GET /metadata/:tokenId` | — | ERC-721 metadata |
| `GET /metadata/:tokenId/image.svg` | — | SVG ticket (VALID / USED) |
| `GET /health` | — | DB, chain head, indexer lag, relayer balance |
| `GET /config` | — | Chain ID, contract, QR TTL (for clients) |
| `GET /docs` | — | Swagger UI |

On-chain writes (create event, buy, list, resale, withdraw, staff) are sent **by the user's wallet** directly to the contract. The only transaction the backend sends is `checkIn`.

Check-in rejection reasons: `QR_MALFORMED`, `QR_EXPIRED`, `WRONG_EVENT`, `NOT_STAFF` (403), `TICKET_NOT_FOUND`, `INVALID_SIGNATURE`, `OWNER_CHANGED`, `QR_REPLAYED`, `OUTSIDE_CHECKIN_WINDOW`, `ALREADY_USED`.

## Design decisions

**Why a relayer?** Staff phones should not need ETH or a wallet popup for every scan. The backend answers instantly from the database, locks the ticket atomically, and queues one `checkIn` transaction per ticket (idempotency key `checkin:<tokenId>`). The relayer signs and stores each attempt *before* broadcasting. After a crash it knows every hash and nonce it may have sent, so it neither loses nor duplicates transactions.

**Why device keys?** A static QR can be screenshotted and shared. A QR signed by the wallet on every refresh would mean a popup every 30 s. Instead, the owner signs one EIP-712 delegation to a key generated on the phone. That key signs a fresh QR (`tokenId, eventId, expiry, random nonce`) every 30 s. Old screenshots expire, replays hit the nonce check, and a delegation stops working once the ticket is resold.

**Reorg handling.** The indexer stores every raw log (`ChainEvent`) and block hashes for the last 256 blocks. Before each batch it compares the stored hash of the last indexed block with the chain. On a mismatch it walks back to the fork point and, in one transaction, deletes the orphaned logs and rebuilds the affected events and tickets from the logs that remain. Off-chain fields (description, venue) survive. A ticket already admitted at the door stays `CHECKING_IN`, and the relayer re-confirms it.

**Database.** SQLite through Prisma 7 (driver adapter). Wei amounts are strings, block numbers are BigInt and enums are strings, so moving to PostgreSQL only means changing `provider` and `DATABASE_URL`.

## Deploying to Sepolia

1. Set `SEPOLIA_RPC_URL`, `SEPOLIA_PRIVATE_KEY` (deployer) and `ETHERSCAN_API_KEY`, either in the Hardhat keystore (`npx hardhat keystore set SEPOLIA_RPC_URL`, …) or as environment variables.
2. Deploy, giving the backend's relayer wallet the relayer role:
   ```bash
   RELAYER_ADDRESS=0xYourRelayer PUBLIC_BASE_URL=https://api.example.com npm run deploy:sepolia
   ```
   This writes `deployments/sepolia.json`.
3. Verify the contract on Etherscan: `npx hardhat verify --network sepolia <address> "https://api.example.com/metadata/"`.
4. Backend `.env`: `CHAIN_ID=11155111`, `RPC_URL=<sepolia rpc>`, `CONFIRMATIONS=3`, `RELAYER_PRIVATE_KEY=<funded relayer key>`, a long random `JWT_SECRET`, and `PUBLIC_BASE_URL`. The contract address is read from `deployments/sepolia.json`, or you can set `CONTRACT_ADDRESS` and `START_BLOCK`.
5. Web UI: `VITE_API_URL`, `VITE_RPC_URL`, `VITE_CHAIN_ID=11155111` and `VITE_DEV_WALLETS=false`.

Never use the Hardhat test keys from `.env.example` on a real network.

## Testing

- **Contracts:** 36 Hardhat tests covering every rule and revert, the transfer lock, and re-entrancy on `withdraw`.
- **Unit:** fake chain and fake transaction sender covering normal sync, idempotent re-runs, reorgs of depth 1 and 3, batch halving, restarts, nonce handling, fee bumping, every check-in error code, and the 10-parallel-scans test.
- **API:** every route, auth, permissions, validation, pagination, rate limits, Swagger, CORS and metadata.
- **E2E:** a real `hardhat node` child process plus the real backend, including a reorg made with `evm_snapshot` / `evm_revert`.
- **Browser:** Playwright drives the web UI with Hardhat dev wallets: organizer creates an event → buyer buys and shows the QR → staff admits it once → resale under the cap → organizer withdraws. It also checks the mobile layout.

CI (`.github/workflows/ci.yml`) runs all of this on Ubuntu, macOS and Windows.

## Out of scope for v1

USDC / ERC-20 payments, gasless purchases (account abstraction), multi-chain deployment, offline scanner mode, PostgreSQL + Redis with separate worker processes, Prometheus/Grafana.
