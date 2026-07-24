CREATE TABLE "karaoke_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"queue_item_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "karaoke_claims_item_guest" UNIQUE("queue_item_id","guest_id")
);
--> statement-breakpoint
ALTER TABLE "karaoke_claims" ADD CONSTRAINT "karaoke_claims_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "karaoke_claims" ADD CONSTRAINT "karaoke_claims_queue_item_id_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."queue_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "karaoke_claims" ADD CONSTRAINT "karaoke_claims_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "karaoke_claims_session" ON "karaoke_claims" USING btree ("session_id");