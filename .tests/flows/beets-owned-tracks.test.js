import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getBeetsOwnedTrackKeys, validateBeetsLibraryDb } from "../../backend/services/flows/beetsOwnedTracks.js";
import { FlowTrackSource } from "../../backend/services/flows/flowTrackSource.js";
import { logger } from "../../backend/services/logger.js";
import { db } from "../../backend/config/db-sqlite.js";
import { dbOps } from "../../backend/db/helpers/settings.js";
import { registerGeneral } from "../../backend/routes/settings/handlers/general.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "aurral-beets-"));
  const path = join(directory, "library.db");
  const previous = process.env.BEETS_LIBRARY_DB;
  const previousSetting = dbOps.getBeetsLibraryDb();
  dbOps.updateSettings({ beetsLibraryDb: "" });
  process.env.BEETS_LIBRARY_DB = path;
  t.after(() => {
    dbOps.updateSettings({ beetsLibraryDb: previousSetting });
    if (previous === undefined) delete process.env.BEETS_LIBRARY_DB;
    else process.env.BEETS_LIBRARY_DB = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const db = new Database(path);
  db.exec("CREATE TABLE items (artist TEXT, title TEXT)");
  db.prepare("INSERT INTO items VALUES (?, ?)").run(" Alice in Chains ", " Nutshell ");
  db.close();
  return path;
}

test("beets keys match flow normalization and skip empty fields", (t) => {
  const path = fixture(t);
  const db = new Database(path);
  const insert = db.prepare("INSERT INTO items VALUES (?, ?)");
  insert.run("", "Song");
  insert.run("Artist", "  ");
  insert.run(null, "Song");
  db.close();
  const keys = getBeetsOwnedTrackKeys();
  assert.deepEqual([...keys], ["alice in chains::nutshell"]);
  const source = new FlowTrackSource();
  assert.ok(keys.has(source._buildBaseCandidate({ artistName: " Alice in Chains ", trackName: " Nutshell " }, "discover").trackKey));
  assert.equal(getBeetsOwnedTrackKeys(), keys, "unchanged mtime reuses the cache");
});

test("unset beets database returns an empty Set without logging", (t) => {
  fixture(t);
  delete process.env.BEETS_LIBRARY_DB;
  const warn = t.mock.method(logger, "warn");
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 0);
});

test("beets failures warn once and reset after recovery, path changes, or mtime changes", (t) => {
  const path = fixture(t);
  process.env.BEETS_LIBRARY_DB = `${path}.missing`;
  const warn = t.mock.method(logger, "warn");
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(warn.mock.calls[0].arguments[0], "flows");
  assert.match(warn.mock.calls[0].arguments[1], /^Beets owned-track check skipped: /);
  const recovered = new Database(process.env.BEETS_LIBRARY_DB);
  recovered.exec("CREATE TABLE items (artist TEXT, title TEXT); INSERT INTO items VALUES ('Recovered', 'Track')");
  recovered.close();
  assert.ok(getBeetsOwnedTrackKeys().has("recovered::track"));
  rmSync(process.env.BEETS_LIBRARY_DB);
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 2, "successful read resets warning suppression");
  process.env.BEETS_LIBRARY_DB = `${path}.another-missing`;
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 3, "changed path resets warning suppression");
  process.env.BEETS_LIBRARY_DB = path;
  const db = new Database(path);
  db.exec("DROP TABLE items");
  db.close();
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 4);
  const { mtimeMs } = statSync(path);
  utimesSync(path, new Date(), new Date(mtimeMs + 2000));
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 5);
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 5);
});

test("beets cache reloads after the database mtime changes", (t) => {
  const path = fixture(t);
  const keys = getBeetsOwnedTrackKeys();
  const { mtimeMs } = statSync(path);
  const db = new Database(path);
  db.prepare("INSERT INTO items VALUES (?, ?)").run("Pearl Jam", "Black");
  db.close();
  utimesSync(path, new Date(), new Date(mtimeMs + 2000));
  const refreshed = getBeetsOwnedTrackKeys();
  assert.notEqual(refreshed, keys);
  assert.ok(refreshed.has("pearl jam::black"));
});

for (const callerKeys of [[], new Set(), ["caller::blocked"], new Set(["caller::blocked"])]) {
  test(`flow plans exclude owned discover tracks and preserve caller ${callerKeys instanceof Set ? "Set" : "array"} (${callerKeys.size ?? callerKeys.length})`, async (t) => {
    fixture(t);
    const source = new FlowTrackSource();
    source._getLibraryArtistKeySet = async () => new Set();
    source._buildFeedbackExcludeKeys = () => [];
    source.getDiscoverTracks = async () => [
      { artistName: "Alice in Chains", trackName: "Nutshell" },
      { artistName: "Unowned", trackName: "Fresh" },
      ...(callerKeys.size || callerKeys.length ? [{ artistName: "Caller", trackName: "Blocked" }] : []),
    ];
    const flow = { size: 3, mix: { discover: 100, mix: 0, trending: 0, focus: 0 } };
    const options = { excludeTrackKeys: callerKeys, reserveSize: 3 };
    const plan = await source.buildFlowRunPlan(flow, options);
    assert.deepEqual(plan.primaryTracks.map((track) => track.trackName), ["Fresh"]);
    const reserve = await source.buildFlowReservePlan(flow, [], options);
    assert.deepEqual(reserve.reserveTracks.map((track) => track.trackName), ["Fresh"]);
  });
}

test("Release Radar does not read the beets database", async (t) => {
  const path = fixture(t);
  process.env.BEETS_LIBRARY_DB = `${path}.missing`;
  const warn = t.mock.method(logger, "warn");
  const source = new FlowTrackSource();
  source.getReleaseRadarTracks = async () => [{ artistName: "Alice in Chains", trackName: "Nutshell" }];
  source._buildFeedbackExcludeKeys = () => [];
  const plan = await source.buildFlowRunPlan({ size: 1, discoverPresetId: "release-radar" }, { basedOn: [] });
  assert.equal(plan.primaryTracks.length, 1);
  assert.equal(warn.mock.callCount(), 0);
});

test("saved beets database wins over the environment and clearing it restores the fallback", (t) => {
  const path = fixture(t);
  const savedPath = `${path}.saved`;
  const saved = new Database(savedPath);
  saved.exec("CREATE TABLE items (artist TEXT, title TEXT); INSERT INTO items VALUES ('Saved', 'Track')");
  saved.close();

  dbOps.updateSettings({ beetsLibraryDb: ` ${savedPath} ` });
  assert.equal(dbOps.getSettings().beetsLibraryDb, savedPath);
  assert.deepEqual([...getBeetsOwnedTrackKeys()], ["saved::track"]);
  dbOps.updateSettings({ beetsLibraryDb: "  " });
  assert.equal(dbOps.getSettings().beetsLibraryDb, "");
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get("beetsLibraryDb"), undefined);
  assert.deepEqual([...getBeetsOwnedTrackKeys()], ["alice in chains::nutshell"]);
});

test("beets database validation accepts a trimmed valid fixture and clearing the path", (t) => {
  const path = fixture(t);
  assert.deepEqual(validateBeetsLibraryDb(` ${path} `), { valid: true, path });
  assert.deepEqual(validateBeetsLibraryDb("  "), { valid: true, path: "" });
});

test("beets database validation rejects invalid paths and schemas without creating files", (t) => {
  const path = fixture(t);
  const missingPath = `${path}.missing`;
  const textPath = `${path}.txt`;
  writeFileSync(textPath, "not a SQLite database");
  const invalidPaths = [
    ["library.db", "Beets library database path must be absolute"],
    [missingPath, /^Beets library database could not be opened as read-only SQLite: /],
    [textPath, /^Beets library database could not be opened as read-only SQLite: /],
    [null, "Beets library database path must be a string"],
  ];
  for (const [index, schema] of [
    "CREATE TABLE other (artist TEXT, title TEXT)",
    "CREATE TABLE items (artist TEXT)",
    "CREATE TABLE items (title TEXT)",
  ].entries()) {
    const invalidPath = `${path}.schema-${index}`;
    const invalid = new Database(invalidPath);
    invalid.exec(schema);
    invalid.close();
    invalidPaths.push([invalidPath, "Beets library database must have an items table with artist and title columns"]);
  }
  for (const [value, error] of invalidPaths) {
    const result = validateBeetsLibraryDb(value);
    assert.equal(result.valid, false, String(value));
    if (error instanceof RegExp) assert.match(result.error, error);
    else assert.equal(result.error, error);
  }
  assert.equal(existsSync(missingPath), false);
});

test("settings return the saved beets path separately from the environment and reject invalid saves", async (t) => {
  const path = fixture(t);
  const routes = {};
  registerGeneral({
    get(path, ...handlers) { routes[`GET ${path}`] = handlers.at(-1); },
    post(path, ...handlers) { routes[`POST ${path}`] = handlers.at(-1); },
  });
  const request = async (method, body) => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
    await routes[`${method} /`]({ body, user: { id: 1 } }, response);
    return response;
  };
  const initial = await request("GET");
  assert.equal(initial.body.beetsLibraryDb, "");
  assert.equal(initial.body.beetsLibraryDbEnv, path);
  assert.equal(dbOps.getBeetsLibraryDb(), "", "GET must not save the environment fallback");
  const saved = await request("POST", { beetsLibraryDb: ` ${path} ` });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.beetsLibraryDb, path);
  assert.equal((await request("GET")).body.beetsLibraryDb, path);
  for (const invalid of ["relative.db", `${path}.missing`, null]) {
    const rejected = await request("POST", { beetsLibraryDb: invalid });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.body.error, validateBeetsLibraryDb(invalid).error);
    assert.equal(dbOps.getBeetsLibraryDb(), path);
  }
  const cleared = await request("POST", { beetsLibraryDb: "  " });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.body.beetsLibraryDb, "");
  assert.equal((await request("GET")).body.beetsLibraryDbEnv, path);
});

test("unrelated settings saves allow an unchanged unreadable beets path but reject a different one", async (t) => {
  const path = fixture(t);
  dbOps.updateSettings({ beetsLibraryDb: path });
  rmSync(path);
  let postSettings;
  registerGeneral({
    get() {},
    post(route, handler) { if (route === "/") postSettings = handler; },
  });
  const save = async (body) => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
    await postSettings({ body, user: { id: 1 } }, response);
    return response;
  };
  const unchanged = await save({ beetsLibraryDb: ` ${path} `, reviewTimeoutHours: 48 });
  assert.equal(unchanged.statusCode, 200);
  assert.equal(dbOps.getSettings().reviewTimeoutHours, 48);
  assert.equal(dbOps.getBeetsLibraryDb(), path);
  const changed = await save({ beetsLibraryDb: `${path}.missing`, reviewTimeoutHours: 72 });
  assert.equal(changed.statusCode, 400);
  assert.match(changed.body.error, /^Beets library database could not be opened as read-only SQLite: /);
  assert.equal(dbOps.getSettings().reviewTimeoutHours, 48);
  assert.equal(dbOps.getBeetsLibraryDb(), path);
});
