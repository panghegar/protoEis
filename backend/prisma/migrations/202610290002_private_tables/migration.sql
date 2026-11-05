-- The dashboard uses the authenticated Express API, never anonymous PostgREST.
-- Table owners (the server-side Prisma connection) can still access these tables.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Worker" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Job" ENABLE ROW LEVEL SECURITY;
