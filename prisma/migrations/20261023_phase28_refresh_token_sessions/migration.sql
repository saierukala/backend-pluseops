-- Phase 28 Account Self-Service: persistent login sessions
-- A session is one login; its id (also the JWT `sessionId` claim) is carried across refresh-token rotation.
-- Rows created before this migration have no session_id and are treated as legacy (never listed, never valid
-- for session-checked access tokens).

ALTER TABLE "public"."refresh_tokens"
  ADD COLUMN "session_id" UUID,
  ADD COLUMN "user_agent" VARCHAR(512),
  ADD COLUMN "ip_address" VARCHAR(64),
  ADD COLUMN "last_used_at" TIMESTAMPTZ(6);

CREATE INDEX "refresh_tokens_session_id_idx" ON "public"."refresh_tokens" USING btree ("session_id");
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "public"."refresh_tokens" USING btree ("user_id", "revoked_at");
