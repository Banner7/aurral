import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getBeetsOwnedTrackKeys } from "../../backend/services/flows/beetsOwnedTracks.js";
import { FlowTrackSource } from "../../backend/services/flows/flowTrackSource.js";
import { logger } from "../../backend/services/logger.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "aurral-beets-"));
  const path = join(directory, "library.db");
  const previous = process.env.BEETS_LIBRARY_DB;
  process.env.BEETS_LIBRARY_DB = path;
  t.after(() => {
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

test("missing beets database warns once, retries, and resets after recovery or path changes", (t) => {
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
});

test("beets failure warnings reset when the database mtime changes", (t) => {
  const path = fixture(t);
  const db = new Database(path);
  db.exec("DROP TABLE items");
  db.close();
  const warn = t.mock.method(logger, "warn", () => {});
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 1);
  const { mtimeMs } = statSync(path);
  utimesSync(path, new Date(), new Date(mtimeMs + 2000));
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 2);
  assert.deepEqual(getBeetsOwnedTrackKeys(), new Set());
  assert.equal(warn.mock.callCount(), 2);
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
