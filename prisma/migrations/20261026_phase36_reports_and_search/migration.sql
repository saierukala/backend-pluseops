-- Phase 36: scheduled reports (report_schedules, reports.schedule_id) and a created_at index for report retention.
-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "schedule_id" TEXT;

-- CreateTable
CREATE TABLE "report_schedules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_by" TEXT,
    "name" TEXT NOT NULL,
    "type" "ReportType" NOT NULL,
    "frequency" "ReportFrequency" NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "recipient_user_ids" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_period" TEXT,
    "last_run_at" TIMESTAMPTZ(6),
    "last_report_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_schedules_tenant_id_idx" ON "report_schedules"("tenant_id");

-- CreateIndex
CREATE INDEX "report_schedules_enabled_idx" ON "report_schedules"("enabled");

-- CreateIndex
CREATE INDEX "reports_created_at_idx" ON "reports"("created_at");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "report_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Same cross-tenant guard as Phase 34 for the new relations
CREATE TRIGGER "report_schedules_created_by_same_tenant" BEFORE INSERT OR UPDATE OF "created_by", "tenant_id" ON "report_schedules"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('users', 'created_by');
CREATE TRIGGER "reports_schedule_id_same_tenant" BEFORE INSERT OR UPDATE OF "schedule_id", "tenant_id" ON "reports"
  FOR EACH ROW EXECUTE FUNCTION pulseops_assert_same_tenant('report_schedules', 'schedule_id');
