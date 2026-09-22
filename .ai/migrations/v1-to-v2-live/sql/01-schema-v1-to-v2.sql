-- CreateEnum
CREATE TYPE "DealTaskType" AS ENUM ('HELP', 'HANDOVER');

-- CreateEnum
CREATE TYPE "DealTaskContent" AS ENUM ('PRICE', 'DESIGN', 'OTHER');

-- CreateEnum
CREATE TYPE "DealTaskStatus" AS ENUM ('OPEN', 'DONE', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DealTaskPartStatus" AS ENUM ('REQUESTED', 'DELIVERED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DealOwnershipReason" AS ENUM ('HANDOFF', 'CHANGE', 'BULK', 'TAKEOVER', 'HANDOVER', 'REVERT');

-- CreateEnum
CREATE TYPE "RequestContent" AS ENUM ('INFO', 'PRICELIST', 'PRICE', 'DESIGN', 'REVIEW');

-- CreateEnum
CREATE TYPE "RequestState" AS ENUM ('OPEN', 'SENT', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RequestOrigin" AS ENUM ('LIVE', 'MIGRATED_RECEIPT', 'MIGRATED_OPEN_STEP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'CALLER_ASSIGNED';
ALTER TYPE "ActivityType" ADD VALUE 'CALLER_RELEASED';
ALTER TYPE "ActivityType" ADD VALUE 'CALL_REVERTED';
ALTER TYPE "ActivityType" ADD VALUE 'DEAL_REOPENED';
ALTER TYPE "ActivityType" ADD VALUE 'OFFER_SENT';
ALTER TYPE "ActivityType" ADD VALUE 'CLIENT_REPLIED';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_CREATED';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_MESSAGE';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_DONE';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_DECLINED';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_CANCELLED';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_REASSIGNED';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_RESULT_DISMISSED';
ALTER TYPE "ActivityType" ADD VALUE 'CLIENT_ASK_CHANGED';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_PART_ADDED';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_PART_DONE';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_PART_DECLINED';
ALTER TYPE "ActivityType" ADD VALUE 'TASK_PART_WITHDRAWN';
ALTER TYPE "ActivityType" ADD VALUE 'PRICE_CHANGED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CallOutcome" ADD VALUE 'WANTS_TO_ORDER';
ALTER TYPE "CallOutcome" ADD VALUE 'INTERESTED';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SALES_REP';

-- AlterEnum
ALTER TYPE "ActivitySource" ADD VALUE 'CLIENTS';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "assignedCallerAt" TIMESTAMP(3),
ADD COLUMN     "assignedCallerId" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "handedOffById" TEXT,
ADD COLUMN     "offerAboutUsAt" TIMESTAMP(3),
ADD COLUMN     "offerPriceAt" TIMESTAMP(3),
ADD COLUMN     "offerPricelistAt" TIMESTAMP(3),
ADD COLUMN     "offerReviewAt" TIMESTAMP(3),
ADD COLUMN     "pipelineEnteredAt" TIMESTAMP(3),
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "leadRevision" INTEGER,
ADD COLUMN     "revertedAt" TIMESTAMP(3),
ADD COLUMN     "revertedById" TEXT,
ADD COLUMN     "taskId" TEXT;

-- CreateTable
CREATE TABLE "DealTask" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "DealTaskType" NOT NULL,
    "status" "DealTaskStatus" NOT NULL DEFAULT 'OPEN',
    "text" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeReason" TEXT,
    "fallbackKind" "NextActionKind",
    "fallbackNote" TEXT,

    CONSTRAINT "DealTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealTaskPart" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" "DealTaskContent" NOT NULL,
    "status" "DealTaskPartStatus" NOT NULL DEFAULT 'REQUESTED',
    "result" JSONB,
    "addedById" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "DealTaskPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadRequest" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "content" "RequestContent" NOT NULL,
    "state" "RequestState" NOT NULL DEFAULT 'OPEN',
    "origin" "RequestOrigin" NOT NULL DEFAULT 'LIVE',
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "requestedById" TEXT,
    "sourceActivityId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedActivityId" TEXT,
    "reason" TEXT,
    "migrationKey" TEXT,
    "provenance" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealOwnership" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "byUserId" TEXT NOT NULL,
    "reason" "DealOwnershipReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealTask_assigneeId_status_createdAt_idx" ON "DealTask"("assigneeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DealTask_leadId_status_idx" ON "DealTask"("leadId", "status");

-- CreateIndex
CREATE INDEX "DealTaskPart_taskId_status_idx" ON "DealTaskPart"("taskId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DealTaskPart_taskId_kind_key" ON "DealTaskPart"("taskId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "LeadRequest_migrationKey_key" ON "LeadRequest"("migrationKey");

-- CreateIndex
CREATE INDEX "LeadRequest_leadId_state_idx" ON "LeadRequest"("leadId", "state");

-- CreateIndex
CREATE INDEX "LeadRequest_leadId_content_state_idx" ON "LeadRequest"("leadId", "content", "state");

-- CreateIndex
CREATE INDEX "DealOwnership_leadId_createdAt_idx" ON "DealOwnership"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "DealOwnership_fromUserId_createdAt_idx" ON "DealOwnership"("fromUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_status_assignedCallerId_createdAt_idx" ON "Lead"("status", "assignedCallerId", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_assignedCallerId_status_callbackKind_idx" ON "Lead"("assignedCallerId", "status", "callbackKind");

-- CreateIndex
CREATE INDEX "Lead_ownerId_status_idx" ON "Lead"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Lead_pipelineEnteredAt_status_idx" ON "Lead"("pipelineEnteredAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_idempotencyKey_key" ON "Activity"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Activity_taskId_idx" ON "Activity"("taskId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedCallerId_fkey" FOREIGN KEY ("assignedCallerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_handedOffById_fkey" FOREIGN KEY ("handedOffById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_revertedById_fkey" FOREIGN KEY ("revertedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DealTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealTask" ADD CONSTRAINT "DealTask_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealTaskPart" ADD CONSTRAINT "DealTaskPart_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DealTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealTaskPart" ADD CONSTRAINT "DealTaskPart_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealTaskPart" ADD CONSTRAINT "DealTaskPart_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRequest" ADD CONSTRAINT "LeadRequest_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRequest" ADD CONSTRAINT "LeadRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRequest" ADD CONSTRAINT "LeadRequest_sourceActivityId_fkey" FOREIGN KEY ("sourceActivityId") REFERENCES "Activity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRequest" ADD CONSTRAINT "LeadRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRequest" ADD CONSTRAINT "LeadRequest_resolvedActivityId_fkey" FOREIGN KEY ("resolvedActivityId") REFERENCES "Activity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealOwnership" ADD CONSTRAINT "DealOwnership_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealOwnership" ADD CONSTRAINT "DealOwnership_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealOwnership" ADD CONSTRAINT "DealOwnership_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealOwnership" ADD CONSTRAINT "DealOwnership_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
