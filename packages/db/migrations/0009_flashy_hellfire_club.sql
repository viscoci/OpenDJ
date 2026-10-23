ALTER TABLE "provider_connections" ADD COLUMN "search_rate_limited_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "rate_limited_client_id" text;