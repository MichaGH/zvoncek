-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "archiveOfId" TEXT,
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "round" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "roundStartedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Lead_archiveOfId_idx" ON "Lead"("archiveOfId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_archiveOfId_fkey" FOREIGN KEY ("archiveOfId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
