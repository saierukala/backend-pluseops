-- Phase 31 Reports: CSV exports produced by the report worker and downloaded via signed URL.

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('ORDERS', 'INVENTORY', 'CUSTOMERS');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "requested_by" TEXT,
    "type" "ReportType" NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'csv',
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "filters" JSONB NOT NULL DEFAULT '{}',
    "storage_key" TEXT,
    "row_count" INTEGER,
    "size_bytes" INTEGER,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_tenant_id_created_at_idx" ON "reports"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "reports_tenant_id_status_idx" ON "reports"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

