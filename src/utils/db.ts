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

export async function readText(filename: string, fallback: string): Promise<string> {
  if (BUCKET) {
    try {
      const response = await s3Client().send(
        new GetObjectCommand({ Bucket: BUCKET, Key: filename }),
      );
      const body = await response.Body?.transformToString('utf-8');
      return body ?? fallback;
    } catch (err) {
      if (isNotFoundError(err)) return fallback;
      throw err;
    }
  }

  ensureDataDir();
  const file = path.join(dataDir(), filename);
  if (!fs.existsSync(file)) return fallback;
  return fs.readFileSync(file, 'utf-8');
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
    return;
  }

  ensureDataDir();
  fs.writeFileSync(path.join(dataDir(), filename), content);
}

export async function readJson<T>(filename: string, fallback: T): Promise<T> {
  const body = await readText(filename, '');
  return body ? (JSON.parse(body) as T) : fallback;
}

export async function writeJson<T>(filename: string, data: T): Promise<void> {
  await writeText(filename, JSON.stringify(data, null, 2), 'application/json');
}
