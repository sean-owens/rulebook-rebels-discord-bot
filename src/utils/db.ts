import fs from 'fs';
import path from 'path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = process.env.AWS_S3_BUCKET_NAME;

function s3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_DEFAULT_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

function dataDir(): string {
  return path.join(process.cwd(), 'data');
}

function ensureDataDir(): void {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isNotFoundError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

// In-memory cache of raw file content, keyed by a namespace (S3 bucket, or the
// local data dir path) plus filename, so it can't collide across environments
// or — critically for tests — across different tmpdir-backed data dirs in the
// same process. Caches the *source of truth* (raw content, or "confirmed
// absent"), not a caller's resolved fallback, since different call sites for
// the same file could in principle pass different fallbacks.
//
// Safe only for a single running instance: Railway currently runs this service
// at numReplicas: 1 (see project_railway_deploy memory). If that ever changes,
// this cache would need to move to something shared (e.g. invalidation via a
// pub/sub channel) or be removed, since one instance's writes wouldn't
// invalidate another instance's cache.
const NOT_FOUND = Symbol('not-found');
const fileCache = new Map<string, string | typeof NOT_FOUND>();

function cacheKey(filename: string): string {
  return `${BUCKET ?? dataDir()}::${filename}`;
}

export async function readText(filename: string, fallback: string): Promise<string> {
  const key = cacheKey(filename);
  const cached = fileCache.get(key);
  if (cached !== undefined) {
    return cached === NOT_FOUND ? fallback : cached;
  }

  if (BUCKET) {
    try {
      const response = await s3Client().send(
        new GetObjectCommand({ Bucket: BUCKET, Key: filename }),
      );
      const body = (await response.Body?.transformToString('utf-8')) ?? '';
      fileCache.set(key, body);
      return body || fallback;
    } catch (err) {
      if (isNotFoundError(err)) {
        fileCache.set(key, NOT_FOUND);
        return fallback;
      }
      throw err;
    }
  }

  ensureDataDir();
  const file = path.join(dataDir(), filename);
  if (!fs.existsSync(file)) {
    fileCache.set(key, NOT_FOUND);
    return fallback;
  }
  const content = fs.readFileSync(file, 'utf-8');
  fileCache.set(key, content);
  return content;
}

export async function writeText(
  filename: string,
  content: string,
  contentType = 'text/plain',
): Promise<void> {
  if (BUCKET) {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: filename,
        Body: content,
        ContentType: contentType,
      }),
    );
    fileCache.set(cacheKey(filename), content);
    return;
  }

  ensureDataDir();
  fs.writeFileSync(path.join(dataDir(), filename), content);
  fileCache.set(cacheKey(filename), content);
}

// Exposed for tests that need a clean slate between runs sharing a process.
export function clearReadCache(): void {
  fileCache.clear();
}

export async function readJson<T>(filename: string, fallback: T): Promise<T> {
  const body = await readText(filename, '');
  return body ? (JSON.parse(body) as T) : fallback;
}

export async function writeJson<T>(filename: string, data: T): Promise<void> {
  await writeText(filename, JSON.stringify(data, null, 2), 'application/json');
}
