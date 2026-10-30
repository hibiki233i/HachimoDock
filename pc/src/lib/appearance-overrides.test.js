import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeVideoOverrides, removeVideoOverrides, parseBitrateSettings } from './appearance-overrides.js';

test('video overrides replace only requested family and add missing action', () => {
  const families = [{ family: 'idle', videoSrc: 'factory' }, { family: 'done', videoSrc: 'done' }];
  const merged = mergeVideoOverrides(families, { idle: 'local/idle.mp4', working: 'local/working.mp4' }, p => `url:${p}`);
  assert.equal(merged.find(x => x.family === 'idle').videoSrc, 'url:local/idle.mp4');
  assert.equal(merged.find(x => x.family === 'done').videoSrc, 'done');
  assert.equal(merged.find(x => x.family === 'working').videoPath, 'local/working.mp4');
});
test('restore one or all preserves only unrequested overrides', () => {
  assert.deepEqual(removeVideoOverrides({ idle: 'a', done: 'b' }, 'idle'), { done: 'b' });
  assert.deepEqual(removeVideoOverrides({ idle: 'a' }), {});
});
test('per action bitrate settings omit blanks and reject invalid rates', () => {
  assert.deepEqual(parseBitrateSettings({ idle: '', done: '900' }), { done: 900 });
  assert.throws(() => parseBitrateSettings({ idle: '0' }), /1.*10000/);
  assert.throws(() => parseBitrateSettings({ idle: '1.5' }), /1.*10000/);
});

test('replacing an action twice changes preview identity while preserving its source path', () => {
  const overrides = { idle: 'local/idle.mp4' };
  const first = mergeVideoOverrides([], overrides, p => `url:${p}`, { idle: 'revision-1' })[0];
  const second = mergeVideoOverrides([], overrides, p => `url:${p}`, { idle: 'revision-2' })[0];
  assert.equal(first.videoPath, second.videoPath);
  assert.notEqual(first.videoSrc, second.videoSrc);
  assert.notEqual(first.videoRevision, second.videoRevision);
});

test('an in-flight media save excludes rebuild, restore and both sync paths until it fails', async () => {
  const { createAppearanceOperationGate } = await import('./appearance-overrides.js');
  const gate = createAppearanceOperationGate();
  let release;
  const upload = (async () => {
    assert.equal(gate.begin(), true);
    try { await new Promise(resolve => { release = resolve; }); throw new Error('save failed'); }
    finally { gate.end(); }
  })();
  for (const action of ['rebuild', 'restore', 'audio sync', 'video sync']) {
    assert.equal(gate.begin(), false, action);
  }
  release();
  await assert.rejects(upload, /save failed/);
  assert.equal(gate.begin(), true);
  gate.end();
});
