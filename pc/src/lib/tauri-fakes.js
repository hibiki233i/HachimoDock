/**
 * [Input] Imports of @tauri-apps/plugin-fs, @tauri-apps/api/path and @tauri-apps/api/core made by appearance-store.js under test.
 * [Output] An in-memory file system, a fixed app-data path and a scriptable P4 preparation command.
 * [Pos] Test support in pc/src/lib, loaded through tauri-fakes-hooks.mjs; never imported by shipped code.
 * [Sync] If appearance-store.js starts using another export of these modules, add it here.
 */

export const BaseDirectory = { AppLocalData: 1 };

/** Path -> string (text files) or Uint8Array (binary files). */
export const files = new Map();
/** Set failPrepare to make `prepare_p4_appearance` reject; calls records every invoked command. */
export const state = { failPrepare: false, calls: [] };

const norm = (p) => String(p).replace(/\/+/g, "/").replace(/\/$/, "");
const isDir = (p) => [...files.keys()].some((k) => k.startsWith(`${norm(p)}/`));

export async function exists(p) { return files.has(norm(p)) || isDir(p); }
export async function mkdir() {}
export async function readDir(p) {
  const prefix = `${norm(p)}/`;
  const names = new Set([...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]));
  return [...names].map((name) => ({ name, isDirectory: false, isFile: true }));
}
export async function readFile(p) {
  const f = files.get(norm(p));
  if (f === undefined) throw new Error(`ENOENT ${p}`);
  return typeof f === "string" ? new TextEncoder().encode(f) : f;
}
export async function readTextFile(p) {
  const f = files.get(norm(p));
  if (f === undefined) throw new Error(`ENOENT ${p}`);
  return typeof f === "string" ? f : new TextDecoder().decode(f);
}
export async function remove(p) { files.delete(norm(p)); }
export async function writeFile(p, bytes) { files.set(norm(p), new Uint8Array(bytes)); }
export async function writeTextFile(p, text) { files.set(norm(p), String(text)); }

export async function appLocalDataDir() { return "/app"; }
export async function join(...parts) { return parts.join("/").replace(/\/+/g, "/"); }

export function convertFileSrc(p) { return `asset://${p}`; }
export async function invoke(command) {
  state.calls.push(command);
  if (command === "prepare_p4_appearance" && state.failPrepare) throw new Error("encode failed");
  return {};
}
