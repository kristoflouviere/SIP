-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "address" TEXT,
    "company" TEXT,
    "phoneNumbers" JSONB,
    "linkedInProfiles" JSONB,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceExternalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contact_email_idx" ON "Contact"("email");

-- CreateIndex
CREATE INDEX "Contact_company_idx" ON "Contact"("company");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_source_external_id_unique" ON "Contact"("source", "sourceExternalId");
