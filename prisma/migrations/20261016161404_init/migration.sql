-- CreateTable
CREATE TABLE "Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "organizer" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "venue" TEXT,
    "priceWei" TEXT NOT NULL,
    "resaleCapWei" TEXT NOT NULL,
    "maxSupply" INTEGER NOT NULL,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "startTime" DATETIME NOT NULL,
    "createdBlock" BIGINT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Ticket" (
    "tokenId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventId" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "listedPriceWei" TEXT,
    "usedAt" DATETIME,
    "mintedBlock" BIGINT NOT NULL,
    CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tokenId" INTEGER NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "priceWei" TEXT,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "block" BIGINT NOT NULL,
    CONSTRAINT "Transfer_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Ticket" ("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Staff" (
    "eventId" INTEGER NOT NULL,
    "wallet" TEXT NOT NULL,

    PRIMARY KEY ("eventId", "wallet"),
    CONSTRAINT "Staff_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChainEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "args" TEXT NOT NULL,
    "tokenId" INTEGER,
    "eventId" INTEGER
);

-- CreateTable
CREATE TABLE "BlockCheckpoint" (
    "number" BIGINT NOT NULL PRIMARY KEY,
    "hash" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "lastIndexedBlock" BIGINT NOT NULL,
    "contractAddress" TEXT
);

-- CreateTable
CREATE TABLE "DeviceKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tokenId" INTEGER NOT NULL,
    "deviceAddr" TEXT NOT NULL,
    "ownerAtReg" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UsedQrNonce" (
    "nonce" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CheckinAttempt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tokenId" INTEGER,
    "eventId" INTEGER NOT NULL,
    "staff" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "txRequestId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TxRequest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "idempotencyKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "nonce" INTEGER,
    "attempts" TEXT NOT NULL DEFAULT '[]',
    "lastHash" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuthNonce" (
    "nonce" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Event_organizer_idx" ON "Event"("organizer");

-- CreateIndex
CREATE INDEX "Event_startTime_idx" ON "Event"("startTime");

-- CreateIndex
CREATE INDEX "Ticket_owner_idx" ON "Ticket"("owner");

-- CreateIndex
CREATE INDEX "Ticket_eventId_status_idx" ON "Ticket"("eventId", "status");

-- CreateIndex
CREATE INDEX "Transfer_tokenId_idx" ON "Transfer"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_txHash_logIndex_key" ON "Transfer"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "ChainEvent_blockNumber_idx" ON "ChainEvent"("blockNumber");

-- CreateIndex
CREATE INDEX "ChainEvent_tokenId_idx" ON "ChainEvent"("tokenId");

-- CreateIndex
CREATE INDEX "ChainEvent_eventId_idx" ON "ChainEvent"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "ChainEvent_txHash_logIndex_key" ON "ChainEvent"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "DeviceKey_tokenId_idx" ON "DeviceKey"("tokenId");

-- CreateIndex
CREATE INDEX "CheckinAttempt_eventId_idx" ON "CheckinAttempt"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TxRequest_idempotencyKey_key" ON "TxRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TxRequest_status_idx" ON "TxRequest"("status");
