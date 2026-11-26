import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../config';

/**
 * Local-disk object storage. Keys are server-generated (never user input).
 * Swap for an S3 implementation behind the same interface when deploying.
 */
export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const root = path.join(dataDir, 'objects');

function resolveKey(key: string): string {
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
  return full;
}

export const storage: ObjectStorage = {
  async put(key, data) {
    const full = resolveKey(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  },
  async get(key) {
    return readFile(resolveKey(key));
  },
  async delete(key) {
    await rm(resolveKey(key), { force: true });
  },
};
