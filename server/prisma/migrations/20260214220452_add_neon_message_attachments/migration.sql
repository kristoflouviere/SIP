-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('FILE', 'CONTACT', 'MEDIA', 'CAMERA', 'LOCATION');

-- CreateEnum
CREATE TYPE "AttachmentStorage" AS ENUM ('DATABASE');

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "ownerNumber" TEXT,
    "counterparty" TEXT,
    "kind" "AttachmentKind" NOT NULL,
    "storage" "AttachmentStorage" NOT NULL DEFAULT 'DATABASE',
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "bytes" BYTEA,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_ownerNumber_counterparty_idx" ON "Attachment"("ownerNumber", "counterparty");

-- CreateIndex
CREATE INDEX "Attachment_kind_idx" ON "Attachment"("kind");

-- CreateIndex
CREATE INDEX "MessageAttachment_attachmentId_idx" ON "MessageAttachment"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageAttachment_messageId_attachmentId_key" ON "MessageAttachment"("messageId", "attachmentId");

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
