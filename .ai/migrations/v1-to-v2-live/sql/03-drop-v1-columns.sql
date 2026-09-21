-- Drops the dead V1 columns. LAST data step of the window: only after 2026-09-v1-sends.ts --verify clean and
-- 2026-09-v2-normalize.ts --verify clean. Non-additive; the Neon restore point taken before the window is the rollback.
-- Guards (division by zero aborts the whole script): the conversion ran and the old send rows are gone.
SELECT 1 / (SELECT (count(*) > 0)::int FROM "Activity" WHERE type = 'OFFER_SENT');
SELECT 1 / (SELECT (count(*) = 0)::int FROM "Activity" WHERE type IN ('EMAIL_SENT','QUOTE_SENT','DESIGN_SENT'));

-- DropForeignKey
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_lockedById_fkey";

-- AlterTable
ALTER TABLE "Lead" DROP COLUMN "aboutUsSentAt",
DROP COLUMN "designUrl",
DROP COLUMN "lockedAt",
DROP COLUMN "lockedById",
DROP COLUMN "priceDisclosed",
DROP COLUMN "quoteSentAt";
