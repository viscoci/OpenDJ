CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_user_id" bigserial NOT NULL,
	"display_name" text,
	"primary_email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"avatar_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_public_user_id_unique" UNIQUE("public_user_id")
);
--> statement-breakpoint
CREATE TABLE "account_memberships" (
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"claims" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_memberships_account_id_user_id_pk" PRIMARY KEY("account_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"provider_subject" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"raw_profile" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_provider_identity" UNIQUE("provider_id","provider_subject")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"current_account_id" uuid,
	"session_hash" text NOT NULL,
	"claims_snapshot" text[] DEFAULT '{}' NOT NULL,
	"ip_hash" text,
	"user_agent_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_sessions_session_hash_unique" UNIQUE("session_hash")
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"flow_kind" text DEFAULT 'login' NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" uuid,
	"user_id" uuid,
	"redirect_to" text,
	"code_verifier" text,
	"nonce" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"hash_algorithm" text NOT NULL,
	"password_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"requested_from_ip_hash" text
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"connected_by_user_id" uuid,
	"provider_id" text NOT NULL,
	"provider_account_id" text,
	"display_name" text,
	"access_token" text,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"scopes" text[],
	"token_type" text,
	"raw_profile" jsonb,
	"raw_token_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_account_provider" UNIQUE("account_id","provider_id"),
	CONSTRAINT "provider_connections_provider_native" UNIQUE("provider_id","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "fingerprint_priority" (
	"fingerprint_hash" text NOT NULL,
	"session_id" uuid NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '48 hours' NOT NULL,
	CONSTRAINT "fingerprint_priority_fingerprint_hash_session_id_pk" PRIMARY KEY("fingerprint_hash","session_id")
);
--> statement-breakpoint
CREATE TABLE "guest_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"fingerprint_hash" text NOT NULL,
	"slot_token" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"queue_position" integer,
	"last_heartbeat" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_slots_slot_token_unique" UNIQUE("slot_token"),
	CONSTRAINT "guest_slots_session_fingerprint" UNIQUE("session_id","fingerprint_hash")
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid,
	"fingerprint" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guests_session_fingerprint" UNIQUE("session_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"session_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"track_uri" text NOT NULL,
	"track_name" text NOT NULL,
	"artist_name" text NOT NULL,
	"album_art_url" text,
	"duration_ms" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_votes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"qr_slug" text NOT NULL,
	"guest_cap_override" integer,
	"songs_per_guest_cap" integer DEFAULT 3 NOT NULL,
	"moderation_enabled" boolean DEFAULT false NOT NULL,
	"vote_skip_mode" text DEFAULT 'fixed' NOT NULL,
	"vote_skip_threshold" integer DEFAULT 5 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "sessions_qr_slug_unique" UNIQUE("qr_slug")
);
--> statement-breakpoint
CREATE TABLE "lyrics_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_lyrics_id" text,
	"provider_track_uri" text,
	"track_name" text NOT NULL,
	"artist_name" text NOT NULL,
	"album_name" text,
	"duration_ms" integer,
	"isrc" text,
	"is_synced" boolean DEFAULT false NOT NULL,
	"is_instrumental" boolean DEFAULT false NOT NULL,
	"match_confidence" text DEFAULT 'medium' NOT NULL,
	"synced_lrc" text,
	"plain_lyrics" text,
	"normalized_payload" jsonb,
	"attribution" text,
	"lookup_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"suppressed_at" timestamp with time zone,
	"suppressed_reason" text,
	CONSTRAINT "lyrics_cache_source_lookup" UNIQUE("source","lookup_key_hash")
);
--> statement-breakpoint
CREATE TABLE "lyrics_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"session_id" uuid,
	"user_id" uuid,
	"guest_id" uuid,
	"lyrics_cache_id" uuid,
	"provider_track_uri" text,
	"kind" text NOT NULL,
	"line_id" text,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abuse_subjects" (
	"subject_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"session_id" uuid,
	"risk_score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'normal' NOT NULL,
	"reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "action_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"session_id" uuid,
	"user_id" uuid,
	"guest_id" uuid,
	"event_kind" text NOT NULL,
	"subject_hash" text,
	"risk_score" numeric(5, 2),
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_current_account_id_accounts_id_fk" FOREIGN KEY ("current_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fingerprint_priority" ADD CONSTRAINT "fingerprint_priority_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_slots" ADD CONSTRAINT "guest_slots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lyrics_feedback" ADD CONSTRAINT "lyrics_feedback_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lyrics_feedback" ADD CONSTRAINT "lyrics_feedback_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lyrics_feedback" ADD CONSTRAINT "lyrics_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lyrics_feedback" ADD CONSTRAINT "lyrics_feedback_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lyrics_feedback" ADD CONSTRAINT "lyrics_feedback_lyrics_cache_id_lyrics_cache_id_fk" FOREIGN KEY ("lyrics_cache_id") REFERENCES "public"."lyrics_cache"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_subjects" ADD CONSTRAINT "abuse_subjects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_subjects" ADD CONSTRAINT "abuse_subjects_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_events" ADD CONSTRAINT "action_events_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_primary_email_unique" ON "users" USING btree (lower("primary_email")) WHERE "users"."primary_email" is not null;--> statement-breakpoint
CREATE INDEX "account_memberships_user" ON "account_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_identities_user" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_active" ON "auth_sessions" USING btree ("user_id","expires_at") WHERE "auth_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_verification_tokens_expiry" ON "email_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_states_expiry" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_expiry" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "provider_connections_account_provider_idx" ON "provider_connections" USING btree ("account_id","provider_id");--> statement-breakpoint
CREATE INDEX "guest_slots_heartbeat" ON "guest_slots" USING btree ("session_id","last_heartbeat") WHERE "guest_slots"."status" = 'active';--> statement-breakpoint
CREATE INDEX "outbox_events_pending" ON "outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "queue_items_session_status" ON "queue_items" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "queue_items_session_created" ON "queue_items" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "session_events_session_created" ON "session_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "lyrics_cache_track_lookup" ON "lyrics_cache" USING btree (lower("track_name"),lower("artist_name"),"duration_ms");--> statement-breakpoint
CREATE INDEX "lyrics_cache_provider_track" ON "lyrics_cache" USING btree ("provider_track_uri") WHERE "lyrics_cache"."provider_track_uri" is not null;--> statement-breakpoint
CREATE INDEX "lyrics_feedback_session_created" ON "lyrics_feedback" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "lyrics_feedback_lyrics_kind" ON "lyrics_feedback" USING btree ("lyrics_cache_id","kind");--> statement-breakpoint
CREATE INDEX "abuse_subjects_session_status" ON "abuse_subjects" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "action_events_session_created" ON "action_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "action_events_subject_created" ON "action_events" USING btree ("subject_hash","created_at") WHERE "action_events"."subject_hash" is not null;