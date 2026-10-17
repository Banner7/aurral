import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { logger } from "../logger.js";
import { dbOps } from "../../db/helpers/settings.js";

let cachedPath;
let cachedMtimeMs;
let cachedKeys;
let lastWarningKey;

export function validateBeetsLibraryDb(value) {
  if (typeof value !== "string") {
    return { valid: false, error: "Beets library database path must be a string" };
  }
  const path = value.trim();
  if (!path) return { valid: true, path };
  if (!isAbsolute(path)) {
    return { valid: false, error: "Beets library database path must be absolute" };
  }

  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'").get();
    const columns = db.pragma("table_info(items)");
    if (!table || !["artist", "title"].every((name) => columns.some((column) => column.name === name))) {
      return { valid: false, error: "Beets library database must have an items table with artist and title columns" };
    }
    return { valid: true, path };
  } catch (error) {
    return { valid: false, error: `Beets library database could not be opened as read-only SQLite: ${error.message}` };
  } finally {
    if (db?.open) db.close();
  }
}

export function getBeetsOwnedTrackKeys() {
  const path = dbOps.getBeetsLibraryDb() || process.env.BEETS_LIBRARY_DB;
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
