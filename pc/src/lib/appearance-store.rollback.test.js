import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Run the real store against in-memory Tauri stand-ins so rollback and recovery are executed, not just read.
register("./tauri-fakes-hooks.mjs", import.meta.url);
const { replaceFamilyVideo, getAppearance } = await import("./appearance-store.js");
const { files, state } = await import("./tauri-fakes.js");

const BASE = "custom-appearances/builtin-terrier";
const IDLE = `${BASE}/video-overrides/idle.mp4`;
const DONE = `${BASE}/video-overrides/done.mp4`;
const OVERRIDES = `${BASE}/video-overrides.json`;
const REVISIONS = `${BASE}/video-revisions.json`;
const PENDING = `${BASE}/prepare-pending`;

function seed({ pending = null, overridesText, revisionsText } = {}) {
  files.clear();
  state.calls.length = 0;
  files.set(IDLE, new Uint8Array([1, 2, 3]));
  files.set(OVERRIDES, overridesText ?? JSON.stringify({ idle: IDLE }, null, 2));
  files.set(REVISIONS, revisionsText ?? JSON.stringify({ idle: "rev-old" }));
  if (pending !== null) files.set(PENDING, pending);
}
const bytes = (p) => (files.has(p) ? Array.from(files.get(p)) : null);
const text = (p) => (files.has(p) ? files.get(p) : null);
const replace = (family) => replaceFamilyVideo({
  appearanceId: "builtin-terrier", family, videoBytes: new Uint8Array([9, 9, 9]), taskId: "t", videoUrl: "u", prompt: "p",
});

test("a failed preparation restores the previous video, overrides, revisions and pending marker", async () => {
  seed();
  const before = { video: bytes(IDLE), overrides: text(OVERRIDES), revisions: text(REVISIONS), pending: text(PENDING) };
  state.failPrepare = true;
  await assert.rejects(replace("idle"), /encode failed/);
  assert.deepEqual({ video: bytes(IDLE), overrides: text(OVERRIDES), revisions: text(REVISIONS), pending: text(PENDING) }, before);
});

test("a failed first-time replacement leaves no trace of the new action", async () => {
  seed();
  const before = { overrides: text(OVERRIDES), revisions: text(REVISIONS), pending: text(PENDING) };
  state.failPrepare = true;
  await assert.rejects(replace("done"), /encode failed/);
  assert.equal(files.has(DONE), false);
  assert.deepEqual({ overrides: text(OVERRIDES), revisions: text(REVISIONS), pending: text(PENDING) }, before);
});

test("a marker that was already pending is unchanged after a failed replacement", async () => {
  seed({ pending: "tok-1" });
  state.failPrepare = true;
  await assert.rejects(replace("idle"), /encode failed/);
  assert.equal(text(PENDING), "tok-1");
  assert.deepEqual(bytes(IDLE), [1, 2, 3]);
});

test("a successful replacement keeps the new video and leaves the marker for the native side to clear", async () => {
  seed();
  state.failPrepare = false;
  await replace("idle");
  assert.deepEqual(bytes(IDLE), [9, 9, 9]);
  assert.equal(JSON.parse(text(OVERRIDES)).idle, IDLE);
  assert.ok(text(PENDING) && text(PENDING).length > 0);
  assert.notEqual(JSON.parse(text(REVISIONS)).idle, "rev-old");
  assert.ok(state.calls.includes("prepare_p4_appearance"));
});

test("unreadable override and revision files still load the default appearance with a notice", async () => {
  seed({ overridesText: '{"idle":', revisionsText: '{"id' });
  const record = await getAppearance("builtin-terrier");
  assert.ok(Array.isArray(record.families) && record.families.length > 0);
  assert.ok(typeof record.overrideError === "string" && record.overrideError.length > 0);
});
