-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "bookmarked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "state" "ConversationState" NOT NULL DEFAULT 'ACTIVE';
