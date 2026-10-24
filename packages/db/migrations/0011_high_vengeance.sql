ALTER TABLE "track_catalog" ADD COLUMN "isrc" text;--> statement-breakpoint
CREATE INDEX "track_catalog_provider_isrc" ON "track_catalog" USING btree ("provider_id","isrc");