CREATE TABLE "track_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"track_uri" text NOT NULL,
	"track_name" text NOT NULL,
	"artist_name" text NOT NULL,
	"album_art_url" text,
	"duration_ms" integer,
	"times_seen" integer DEFAULT 0 NOT NULL,
	"times_requested" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "track_catalog_provider_track" ON "track_catalog" USING btree ("provider_id","track_uri");