-- Routing team "Obchod": telesales positive first calls go to its leader (Michal) instead of "Nepriradené".
-- Idempotent. Fails loudly (division by zero) if the expected users do not exist exactly once.
SELECT 1 / (SELECT count(*)::int FROM "User" WHERE username = 'michal' AND role = 'ADMIN' AND "deletedAt" IS NULL);
SELECT 1 / (SELECT count(*)::int FROM "User" WHERE username = 'timea' AND role = 'TELESALES' AND "deletedAt" IS NULL);

INSERT INTO "Team" (id, name, "leaderId", "createdAt", "updatedAt")
SELECT 'team_obchod_v2', 'Obchod', u.id, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
  FROM "User" u
 WHERE u.username = 'michal'
   AND NOT EXISTS (SELECT 1 FROM "Team" t WHERE t.name = 'Obchod')
   AND NOT EXISTS (SELECT 1 FROM "Team" t WHERE t."leaderId" = u.id);

UPDATE "User" SET "teamId" = (SELECT id FROM "Team" WHERE name = 'Obchod')
 WHERE username = 'timea' AND "teamId" IS NULL;

-- Must be exactly one row: Obchod led by michal, timea a member.
SELECT 1 / (SELECT count(*)::int FROM "Team" t JOIN "User" l ON l.id = t."leaderId" AND l.username = 'michal'
             JOIN "User" m ON m."teamId" = t.id AND m.username = 'timea' WHERE t.name = 'Obchod');
