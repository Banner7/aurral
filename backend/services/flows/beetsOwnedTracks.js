import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { logger } from "../logger.js";

let cachedPath;
let cachedMtimeMs;
let cachedKeys;
let lastWarningKey;

export function getBeetsOwnedTrackKeys() {
  const path = process.env.BEETS_LIBRARY_DB;
  if (!path) {
    lastWarningKey = undefined;
    return new Set();
  }

  let db;
  let mtimeMs;
  try {
    mtimeMs = statSync(path).mtimeMs;
    if (path === cachedPath && mtimeMs === cachedMtimeMs) return cachedKeys;

    db = new Database(path, { readonly: true, fileMustExist: true });
    const keys = new Set();
    for (const row of db.prepare("SELECT artist, title FROM items").iterate()) {
      const artist = String(row.artist || "").trim().toLowerCase();
      const title = String(row.title || "").trim().toLowerCase();
      if (artist && title) keys.add(`${artist}::${title}`);
    }
    cachedPath = path;
    cachedMtimeMs = mtimeMs;
    cachedKeys = keys;
    lastWarningKey = undefined;
    return keys;
  } catch (error) {
    cachedPath = undefined;
    cachedMtimeMs = undefined;
    cachedKeys = undefined;
    const warningKey = `${path}\0${mtimeMs}\0${error.message}`;
    if (warningKey !== lastWarningKey) {
      lastWarningKey = warningKey;
      logger.warn("flows", `Beets owned-track check skipped: ${error.message}`);
    }
    return new Set();
  } finally {
    if (db?.open) db.close();
  }
}
