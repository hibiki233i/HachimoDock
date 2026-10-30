/**
 * [Input] Module specifiers requested while a test imports front-end code that talks to Tauri.
 * [Output] Resolves every @tauri-apps/* specifier to tauri-fakes.js so the real code runs against in-memory stand-ins.
 * [Pos] Node module-resolution hook registered by appearance-store.rollback.test.js.
 * [Sync] If tauri-fakes.js is renamed, update the URL below.
 */
const fakes = new URL("./tauri-fakes.js", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@tauri-apps/")) return { url: fakes, shortCircuit: true };
  return nextResolve(specifier, context);
}
