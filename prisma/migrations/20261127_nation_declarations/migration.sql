BEGIN;

-- CreateTable
CREATE TABLE "public"."TerritoryDeclaration" (
    "id" TEXT NOT NULL,
    "missionKey" VARCHAR(255) NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "dong" VARCHAR(64) NOT NULL,
    "castleKey" VARCHAR(255) NOT NULL,
    "proposerId" VARCHAR(255) NOT NULL,
    "name" VARCHAR(30) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "nationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerritoryDeclaration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TerritoryDeclarationVote" (
    "declarationId" TEXT NOT NULL,
    "userId" VARCHAR(255) NOT NULL,
    "consent" BOOLEAN,

    CONSTRAINT "TerritoryDeclarationVote_pkey" PRIMARY KEY ("declarationId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TerritoryDeclaration_nationId_key" ON "public"."TerritoryDeclaration"("nationId");

-- CreateIndex
CREATE INDEX "TerritoryDeclaration_missionKey_seasonId_dong_status_idx" ON "public"."TerritoryDeclaration"("missionKey", "seasonId", "dong", "status");

-- CreateIndex
CREATE INDEX "TerritoryDeclarationVote_userId_consent_idx" ON "public"."TerritoryDeclarationVote"("userId", "consent");

-- AddForeignKey
ALTER TABLE "public"."TerritoryDeclaration" ADD CONSTRAINT "TerritoryDeclaration_nationId_fkey" FOREIGN KEY ("nationId") REFERENCES "public"."TerritoryNation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TerritoryDeclarationVote" ADD CONSTRAINT "TerritoryDeclarationVote_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "public"."TerritoryDeclaration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only one pending or ratified proclamation may represent a district in a season.
CREATE UNIQUE INDEX "declaration_active_region" ON "public"."TerritoryDeclaration"("missionKey", "seasonId", "dong")
    WHERE "status" IN ('pending', 'approved');

COMMIT;
