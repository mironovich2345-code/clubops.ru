import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { type StorageProvider, isSafeStorageKey } from "./types";

// Local disk provider for development (and any host with a persistent volume).
// Files live under <cwd>/uploads/<key>. Used as the default and the safe
// fallback so existing Railway/local behavior is unchanged.
const UPLOAD_ROOT = join(process.cwd(), "uploads");

function resolve(key: string): string {
  if (!isSafeStorageKey(key)) throw new Error("Unsafe storage key");
  return join(UPLOAD_ROOT, key);
}

export function createLocalStorageProvider(): StorageProvider {
  return {
    name: "local",

    async put(key, buffer) {
      const path = resolve(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buffer);
    },

    async get(key) {
      let path: string;
      try {
        path = resolve(key);
      } catch {
        return null;
      }
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    },

    async exists(key) {
      let path: string;
      try {
        path = resolve(key);
      } catch {
        return false;
      }
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },

    // Local disk has no signed URL — callers use the app download routes.
    async getSignedUrl() {
      return null;
    },

    async delete(key) {
      try {
        await unlink(resolve(key));
      } catch {
        // already gone / never written — nothing to do.
      }
    },
  };
}
