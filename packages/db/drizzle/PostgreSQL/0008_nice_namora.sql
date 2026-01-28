ALTER TABLE "scheduled_tasks" ALTER COLUMN "min_credits_required" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" DROP COLUMN "max_concurrent_executions";