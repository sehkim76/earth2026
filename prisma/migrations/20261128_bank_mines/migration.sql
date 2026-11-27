-- CreateTable
CREATE TABLE "public"."TerritoryGoldMine" (
    "missionKey" VARCHAR(255) NOT NULL,
    "nodeId" VARCHAR(64) NOT NULL,
    "mined" INTEGER NOT NULL,
    "reservations" JSONB NOT NULL,
    "respawnAt" TIMESTAMP(3),

    CONSTRAINT "TerritoryGoldMine_pkey" PRIMARY KEY ("missionKey","nodeId")
);

