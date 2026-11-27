ALTER TABLE "notifications" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deadline_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "overdue_notified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notifications_dispatch_idx" ON "notifications" USING btree ("created_at") WHERE "notifications"."dispatched_at" IS NULL;--> statement-breakpoint
-- avisos antigos não devem sair por e-mail/push ao ligar o despachante
UPDATE "notifications" SET "dispatched_at" = "created_at";
