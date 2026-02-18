-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "importedAt" TIMESTAMP(3),
ADD COLUMN     "sourceImportMeta" JSONB;
