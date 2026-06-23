import fs from 'fs';
import path from 'path';

function dataDir(): string {
  return path.join(process.cwd(), 'data');
}

function ensureDataDir(): void {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(filename: string, fallback: T): T {
  ensureDataDir();
  const file = path.join(dataDir(), filename);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

export function writeJson<T>(filename: string, data: T): void {
  ensureDataDir();
  fs.writeFileSync(path.join(dataDir(), filename), JSON.stringify(data, null, 2));
}
