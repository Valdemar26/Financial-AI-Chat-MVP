-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "cache_written_tokens" INTEGER,
ADD COLUMN     "cost_usd" DOUBLE PRECISION,
ADD COLUMN     "duration_ms" INTEGER;
