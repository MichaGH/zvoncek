import { BUSINESS_TZ } from "../../lib/domain/businessTime";

// SQL stavebné kocky pre 2026-09-wave5-requests.ts – vlastný modul bez vedľajších účinkov, aby ich vedel spustiť aj
// test (check-concurrency.ts w5Migration) na PRESNE TÝCH ISTÝCH príkazoch, nie na ich kópii (R01-1).

// Obsah požiadavky ↔ obsah odoslania, ktoré ju spĺňa (§5). REVIEW sem zámerne nepatrí. PRICELIST sa objaví len tam,
// kde ho do kanonického odoslania doplnil prevod starých odoslaní (R01-1) – tento skript ho nikdy nehádá.
export const RECEIPT_SOURCES = [
    { content: "INFO", sent: "ABOUT_US" },
    { content: "PRICELIST", sent: "PRICELIST" },
    { content: "PRICE", sent: "PRICE" },
    { content: "DESIGN", sent: "DESIGN" },
] as const;

export const STEP_SOURCES = [
    { kind: "SEND_QUOTE", content: "PRICE", sent: "PRICE" },
    { kind: "SEND_DESIGN", content: "DESIGN", sent: "DESIGN" },
    { kind: "SEND_EMAIL", content: "INFO", sent: "ABOUT_US" },
] as const;

// Okamih odoslania – PRESNE pravidlo offerInstant() z lib/domain/offers.ts (R02-6): dnešný záznam nesie čas zápisu, ak sa
// obchodný deň zápisu zhoduje s meta.sentOn, inak polnoc obchodného dňa sentOn v Europe/Bratislava (nie UTC!). Ak by sa
// líšili, prepočet po migrácii by považoval migrovanú požiadavku za novšiu než jej odoslanie a znova by ju otvoril.
// Zhodu s TypeScriptom strieže test w5InstantParity.
export const instantSql = `CASE
        WHEN ((a."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE '${BUSINESS_TZ}')::date::text = a.meta->>'sentOn'
        THEN a."createdAt"
        ELSE (((a.meta->>'sentOn')::date)::timestamp AT TIME ZONE '${BUSINESS_TZ}') AT TIME ZONE 'UTC'
    END`;

export function receiptRows(content: string, sent: string): string {
    return `
        SELECT DISTINCT ON (a."leadId")
               a."leadId", a.id AS "activityId", a."userId", ${instantSql} AS instant, a.meta->>'sentOn' AS "sentOn"
          FROM "Activity" a
         WHERE a.type = 'OFFER_SENT' AND a."revertedAt" IS NULL
           AND a.meta->'contents' ? '${sent}'
         ORDER BY a."leadId", ${instantSql} ASC, a.id ASC`;
}

// Jeden riadok na (obchod, obsah) z PRVÉHO odoslania – klient si to vyžiadal raz, nie pri každom emaili.
export function insertReceipts(content: string, sent: string): string {
    return `
        INSERT INTO "LeadRequest" (id, "leadId", content, state, origin, "requestedAt", "requestedById",
                                   "sourceActivityId", "resolvedAt", "resolvedById", "resolvedActivityId",
                                   "migrationKey", provenance, "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, r."leadId", '${content}', 'SENT', 'MIGRATED_RECEIPT', r.instant, NULL,
               NULL, r.instant, r."userId", r."activityId",
               'w5:receipt:' || r."leadId" || ':${content}',
               jsonb_build_object('source', 'OFFER_SENT', 'activityId', r."activityId", 'sentOn', r."sentOn",
                                  'rule', 'received implies asked', 'confidence', 'high'),
               now(), now()
          FROM (${receiptRows(content, sent)}) r
         WHERE NOT EXISTS (SELECT 1 FROM "LeadRequest" x WHERE x."leadId" = r."leadId" AND x.content = '${content}')
        ON CONFLICT ("migrationKey") DO NOTHING`;
}

// Otvorený obchod s odosielacím krokom, pre ktorý neexistuje zodpovedajúce platné odoslanie = nesplnená požiadavka.
export function openStepRows(kind: string, content: string, sent: string): string {
    return `
        SELECT l.id AS "leadId", COALESCE(l."pipelineEnteredAt", l."createdAt") AS instant
          FROM "Lead" l
         WHERE l."deletedAt" IS NULL AND l."pipelineEnteredAt" IS NOT NULL
           AND l.status IN ('ACTIVE', 'SNOOZED')
           AND l."nextActionKind" = '${kind}'
           AND NOT EXISTS (
                 SELECT 1 FROM "Activity" a
                  WHERE a."leadId" = l.id AND a.type = 'OFFER_SENT' AND a."revertedAt" IS NULL
                    AND a.meta->'contents' ? '${sent}')`;
}

export function insertOpenStep(kind: string, content: string, sent: string): string {
    return `
        INSERT INTO "LeadRequest" (id, "leadId", content, state, origin, "requestedAt", "requestedById",
                                   "migrationKey", provenance, "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, s."leadId", '${content}', 'OPEN', 'MIGRATED_OPEN_STEP', s.instant, NULL,
               'w5:step:' || s."leadId" || ':${content}',
               jsonb_build_object('source', 'nextActionKind', 'kind', '${kind}',
                                  'rule', 'open send step without a receipt', 'confidence', 'inferred'),
               now(), now()
          FROM (${openStepRows(kind, content, sent)}) s
         WHERE NOT EXISTS (SELECT 1 FROM "LeadRequest" x WHERE x."leadId" = s."leadId" AND x.content = '${content}')
        ON CONFLICT ("migrationKey") DO NOTHING`;
}
