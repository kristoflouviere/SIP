-- CreateTable
CREATE TABLE "FromNumber" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "firstUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FromNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToNumber" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "firstUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FromNumber_number_key" ON "FromNumber"("number");

-- CreateIndex
CREATE UNIQUE INDEX "ToNumber_number_key" ON "ToNumber"("number");
