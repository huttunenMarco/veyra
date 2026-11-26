ALTER TABLE "api_keys" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "api_keys" CASCADE;--> statement-breakpoint
DROP TABLE "memberships" CASCADE;--> statement-breakpoint
DROP TABLE "sessions" CASCADE;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "sensor_feedback" DROP CONSTRAINT IF EXISTS "sensor_feedback_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "openai_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "openai_model" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "openai_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "sensor_feedback" DROP COLUMN "user_id";