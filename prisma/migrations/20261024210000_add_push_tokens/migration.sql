CREATE TABLE IF NOT EXISTS "tsmib_push_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "expo_push_token" VARCHAR(255) NOT NULL,
    "device_name" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    CONSTRAINT "tsmib_push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tsmib_push_tokens_expo_push_token_key"
    ON "tsmib_push_tokens"("expo_push_token");

CREATE INDEX IF NOT EXISTS "ix_push_tokens_user"
    ON "tsmib_push_tokens"("user_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tsmib_push_tokens_user_id_fkey'
    ) THEN
        ALTER TABLE "tsmib_push_tokens"
            ADD CONSTRAINT "tsmib_push_tokens_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "tsmib_users"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;
