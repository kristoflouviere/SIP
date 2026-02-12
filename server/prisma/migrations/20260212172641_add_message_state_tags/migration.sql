-- CreateEnum
CREATE TYPE "MessageState" AS ENUM ('READ', 'UNREAD', 'ARCHIVED', 'DELETED');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "state" "MessageState" NOT NULL DEFAULT 'UNREAD',
ADD COLUMN     "tags" JSONB;
