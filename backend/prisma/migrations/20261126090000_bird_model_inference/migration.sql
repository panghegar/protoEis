-- Additive: historic simulation results are preserved.
ALTER TABLE "BirdSegment"
ADD COLUMN "windowIndex" INTEGER,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'detected',
ADD COLUMN "commonName" TEXT,
ADD COLUMN "globalConfidence" DOUBLE PRECISION,
ADD COLUMN "customConfidence" DOUBLE PRECISION,
ADD COLUMN "evidence" TEXT;
