import { mkdir, writeFile, readFile, unlink, stat, readdir } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
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

    async head(key) {
      let path: string;
      try {
        path = resolve(key);
      } catch {
        return null;
      }
      try {
        const s = await stat(path);
        if (!s.isFile()) return null;
        return { size: s.size, etag: null };
      } catch {
        return null;
      }
    },

    // Read-only recursive walk under uploads/<prefix> for the inventory. Returns
    // logical keys (forward-slash separated), never absolute paths.
    async list(prefix, opts) {
      const max = opts?.max ?? 10_000;
      const base = prefix ? join(UPLOAD_ROOT, prefix) : UPLOAD_ROOT;
      const out: string[] = [];
      async function walk(dir: string): Promise<void> {
        let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
        try {
          entries = (await readdir(dir, { withFileTypes: true })) as unknown as typeof entries;
        } catch {
          return;
        }
        for (const e of entries) {
          if (out.length >= max) return;
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else if (e.isFile()) out.push(relative(UPLOAD_ROOT, full).split(sep).join("/"));
        }
      }
      await walk(base);
      return out.slice(0, max);
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
