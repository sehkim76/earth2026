BEGIN;

CREATE UNIQUE INDEX "nation_mission_name"
ON "TerritoryNation" ("missionKey", lower(normalize(btrim(name), NFC)));

CREATE UNIQUE INDEX "declaration_active_mission_name"
ON "TerritoryDeclaration" ("missionKey", lower(normalize(btrim(name), NFC)))
WHERE status IN ('pending', 'approved');

COMMIT;
