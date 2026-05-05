CREATE TABLE "queue_skip_votes" (
	"queue_item_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_skip_votes_queue_item_id_guest_id_pk" PRIMARY KEY("queue_item_id","guest_id")
);
--> statement-breakpoint
ALTER TABLE "queue_skip_votes" ADD CONSTRAINT "queue_skip_votes_queue_item_id_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."queue_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_skip_votes" ADD CONSTRAINT "queue_skip_votes_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_skip_votes_item" ON "queue_skip_votes" USING btree ("queue_item_id");