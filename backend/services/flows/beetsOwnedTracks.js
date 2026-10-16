import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { logger } from "../logger.js";

let cachedPath;
let cachedMtimeMs;
let cachedKeys;
let failure;

export function getBeetsOwnedTrackKeys() {
  const path = process.env.BEETS_LIBRARY_DB;
  if (!path) {
    failure = undefined;
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
    db.close();
    db = undefined;
    cachedPath = path;
    cachedMtimeMs = mtimeMs;
    cachedKeys = keys;
    failure = undefined;
    return keys;
  } catch (error) {
    cachedPath = undefined;
    cachedMtimeMs = undefined;
    cachedKeys = undefined;
    if (failure?.path !== path || failure?.mtimeMs !== mtimeMs) {
      failure = { path, mtimeMs, messages: new Set() };
    }
    if (!failure.messages.has(error.message)) {
      failure.messages.add(error.message);
      logger.warn("flows", `Beets owned-track check skipped: ${error.message}`);
    }
    return new Set();
  } finally {
    if (db?.open) db.close();
  }
}
