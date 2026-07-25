ALTER TABLE "sessions" ADD COLUMN "karaoke_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "karaoke_mic_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "karaoke_pause_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "karaoke_pause_timeout_sec" integer DEFAULT 30 NOT NULL;