-- AlterEnum
ALTER TYPE "AttachmentStorage" ADD VALUE 'OBJECT_STORE';

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "storageEtag" TEXT,
ADD COLUMN     "storageKey" TEXT;

-- CreateIndex
CREATE INDEX "Attachment_storage_idx" ON "Attachment"("storage");

-- CreateIndex
CREATE INDEX "Attachment_storageKey_idx" ON "Attachment"("storageKey");
