ALTER TABLE "tsmib_documents"
    ADD COLUMN IF NOT EXISTS "property_id" UUID,
    ADD COLUMN IF NOT EXISTS "storage_key" VARCHAR(1024),
    ADD COLUMN IF NOT EXISTS "upload_status" VARCHAR(20) NOT NULL DEFAULT 'COMPLETE';

CREATE UNIQUE INDEX IF NOT EXISTS "uq_documents_storage_key"
    ON "tsmib_documents"("storage_key");

CREATE INDEX IF NOT EXISTS "ix_documents_organization"
    ON "tsmib_documents"("organization_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_documents_property'
    ) THEN
        ALTER TABLE "tsmib_documents"
            ADD CONSTRAINT "fk_documents_property"
            FOREIGN KEY ("property_id") REFERENCES "tsmib_properties"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END $$;
