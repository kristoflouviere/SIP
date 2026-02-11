-- CreateTable
CREATE TABLE "MessageEvent" (
    "id" TEXT NOT NULL,
    "telnyxEventId" TEXT,
    "telnyxMessageId" TEXT,
    "eventType" TEXT NOT NULL,
    "status" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageEvent_telnyxEventId_key" ON "MessageEvent"("telnyxEventId");

-- CreateIndex
CREATE INDEX "MessageEvent_telnyxMessageId_idx" ON "MessageEvent"("telnyxMessageId");

-- CreateIndex
CREATE INDEX "MessageEvent_occurredAt_idx" ON "MessageEvent"("occurredAt");

-- AddForeignKey
ALTER TABLE "MessageEvent" ADD CONSTRAINT "MessageEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
