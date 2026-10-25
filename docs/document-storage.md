# Document storage

Documents are stored as private objects in an S3-compatible Neon Storage bucket. The API stores metadata and an object key in PostgreSQL; it does not proxy file contents through the API.

## Configuration

Set these variables in the backend process environment or in the ignored `backend/.env` file:

| Variable | Purpose |
| --- | --- |
| `AWS_ENDPOINT_URL_S3` | Neon S3-compatible endpoint URL |
| `AWS_ACCESS_KEY_ID` | Storage access key ID |
| `AWS_SECRET_ACCESS_KEY` | Storage access key secret |
| `AWS_REGION` | Storage region |
| `AWS_BUCKET_NAME` | Name of the Neon Storage bucket |
| `AWS_S3_FORCE_PATH_STYLE` | Optional; defaults to `true` for S3-compatible endpoints |

Use `backend/.env.example` as the variable-name template. Do not commit actual credentials. Configure a bucket in Neon Storage and set its name as `AWS_BUCKET_NAME` before using document routes.

## Upload flow

1. Authenticated client calls `POST /api/documents/upload-url` with `entityType`, `entityId`, `documentType`, `fileName`, `mimeType`, and `fileSize`.
2. The API verifies the linked entity belongs to the authenticated organization, creates `PENDING` metadata, and returns a 15-minute presigned `PUT` URL with the expected content length signed.
3. The client uploads bytes directly to that URL with the returned `Content-Type` header.
4. The client calls `POST /api/documents/{id}/complete`. The API checks stored object size and content type, copies the verified object to a separate permanent key, and marks metadata `COMPLETE`. The upload URL can no longer overwrite the completed document.
5. Use `GET /api/documents/{id}/download-url` to get a five-minute download URL.

Maximum upload size is 25 MiB. Supported types are PDF, JPEG, PNG, WebP, plain text, DOC/DOCX, and XLS/XLSX. Tenant accounts may upload only to their own tenant profile; they can view documents linked to their tenant, leases, active apartment, and maintenance requests. Only the uploader can delete a tenant-uploaded document. Organization managers may manage documents for any entity in their organization.

For browser-based clients, configure the bucket's CORS policy to allow the application's origin, `PUT`, and the `Content-Type` request header.

Apply the migration in `prisma/migrations/20261024220000_add_document_storage` before deploying the updated API. Existing document rows retain `COMPLETE` status and remain compatible; documents without an S3 object key continue to return their existing `file_url`.
