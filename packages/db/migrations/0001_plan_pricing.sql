ALTER TABLE "plans" ALTER COLUMN "price_yearly_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "price_is_starting_at" boolean DEFAULT false NOT NULL;