-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "family_created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "sessions" ADD COLUMN "last_ip" TEXT;
ALTER TABLE "sessions" ADD COLUMN "rotated_at" TIMESTAMPTZ(3);
ALTER TABLE "sessions" ADD COLUMN "revoked_reason" TEXT;

-- Update existing sessions so family_created_at matches created_at
UPDATE "sessions" SET "family_created_at" = "created_at";

-- CreateIndex
CREATE INDEX "sessions_family_id_rotated_at_idx" ON "sessions"("family_id", "rotated_at");
