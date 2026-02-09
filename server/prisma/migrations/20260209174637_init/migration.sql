-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "text" TEXT,
    "status" TEXT,
    "telnyxMessageId" TEXT,
    "telnyxEventId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
