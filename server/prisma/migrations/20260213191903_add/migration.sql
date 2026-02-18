-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "googleFieldValues" JSONB,
ADD COLUMN     "googleRaw" JSONB,
ADD COLUMN     "sourceDetails" JSONB;
