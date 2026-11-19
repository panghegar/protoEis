ALTER TABLE "Job" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'training',
 ADD COLUMN "audio" JSONB,
 ADD COLUMN "audioExpiresAt" TIMESTAMP(3),
 ADD COLUMN "audioDeletedAt" TIMESTAMP(3),
 ADD COLUMN "audioCleanupCheckedAt" TIMESTAMP(3);
CREATE INDEX "Job_kind_audioExpiresAt_idx" ON "Job"("kind","audioExpiresAt");
CREATE TABLE "BirdSegment" (
 "jobId" TEXT NOT NULL,
 "ordinal" INTEGER NOT NULL,
 "startSeconds" DOUBLE PRECISION NOT NULL,
 "endSeconds" DOUBLE PRECISION NOT NULL,
 "species" TEXT NOT NULL,
 "confidence" DOUBLE PRECISION NOT NULL,
 CONSTRAINT "BirdSegment_pkey" PRIMARY KEY ("jobId","ordinal"),
 CONSTRAINT "BirdSegment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "BirdSegment" ENABLE ROW LEVEL SECURITY;
