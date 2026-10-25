import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../lib/prisma';

const PRESIGNED_UPLOAD_TTL_SECONDS = 15 * 60;
const PRESIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;

let client: S3Client | undefined;

function getStorageConfig() {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_BUCKET_NAME;

  if (!endpoint || !accessKeyId || !secretAccessKey || !region || !bucket) {
    throw new Error('Document storage is not configured. Set the required S3 environment variables.');
  }
  if (!endpoint.startsWith('https://')) {
    throw new Error('Document storage endpoint must use HTTPS.');
  }
  return { endpoint, accessKeyId, secretAccessKey, region, bucket };
}

function getS3Client(): S3Client {
  if (client) return client;
  const config = getStorageConfig();
  client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return client;
}

export async function createUploadUrl(key: string, contentType: string, contentLength: number): Promise<string> {
  const config = getStorageConfig();
  return getSignedUrl(
    getS3Client(),
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS }
  );
}

export async function createDownloadUrl(key: string, fileName: string): Promise<string> {
  const config = getStorageConfig();
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
    }),
    { expiresIn: PRESIGNED_DOWNLOAD_TTL_SECONDS }
  );
}

export async function inspectStoredObject(key: string) {
  const config = getStorageConfig();
  return getS3Client().send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
}

export async function copyStoredObject(sourceKey: string, destinationKey: string): Promise<void> {
  const config = getStorageConfig();
  const copySource = `${config.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
  await getS3Client().send(new CopyObjectCommand({
    Bucket: config.bucket,
    Key: destinationKey,
    CopySource: copySource,
    MetadataDirective: 'COPY',
  }));
}

export async function deleteStoredObject(key: string): Promise<void> {
  const config = getStorageConfig();
  await getS3Client().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

export async function deleteStoredObjectsAfterEntityRemoval(keys: string[], entity: string): Promise<void> {
  for (const key of keys) {
    try {
      await deleteStoredObject(key);
    } catch (error) {
      console.error(`Failed to remove stored document for deleted ${entity} (${key}):`, error);
    }
  }
}

export async function cleanupExpiredDocumentUploads(organizationId: string): Promise<number> {
  const expiresBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const expired = await prisma.tsmib_documents.findMany({
    where: {
      organization_id: organizationId,
      upload_status: 'PENDING',
      created_at: { lt: expiresBefore },
    },
    select: { id: true, storage_key: true },
  });

  let cleaned = 0;
  for (const document of expired) {
    if (document.storage_key) {
      try {
        await deleteStoredObject(document.storage_key);
      } catch (error) {
        console.error(`Failed to clean expired document upload ${document.id}:`, error);
        continue;
      }
    }
    await prisma.tsmib_documents.delete({ where: { id: document.id } });
    cleaned++;
  }
  return cleaned;
}

export function getStorageUri(key: string): string {
  const { bucket } = getStorageConfig();
  return `s3://${bucket}/${key}`;
}
