import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("setup completes only after successful awaited navigation and remains retryable", async () => {
  const source = read("./DeviceSetup.jsx");
  const body = source.match(/const finish = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[onComplete\]\)/)[1];
  const ref = { current: false };
  let attempts = 0;
  const finish = new Function("completedRef", "onComplete", `return async()=>{${body}}`)(ref, async () => {
    if (++attempts === 1) throw Error("read failed");
  });
  await assert.rejects(finish()); assert.equal(ref.current, false);
  await finish(); assert.equal(ref.current, true);
  await finish(); assert.equal(attempts, 2);
  assert.match(read("./App.jsx"), /await handleSetupComplete\(\)/);
  assert.doesNotMatch(read("./App.jsx"), /if \(isSetup\)\s*\{\s*return/);
});

test("page visibility controls component observers without unmounting active work", () => {
  const app = read("./App.jsx"), center = read("./ComponentCenter.jsx");
  assert.match(app, /componentsVisited \|\| view === "components"/);
  assert.match(app, /apiVisited \|\| view === "api"/);
  assert.match(center, /if \(!active\) return;\s*refreshComponentLibrary/);
  assert.match(center, /if \(!active \|\| !componentLibraryPath\)/);
  assert.match(center, /if\(!active \|\| !liveInventoryTarget\)/);
  assert.match(read("./component-center/CommunityCenter.jsx"), /if\(!active \|\| !\[/);
});

test("persona close paths share dirty protection and accessible dialog focus", () => {
  const modal = read("./PersonaVoiceModal.jsx");
  assert.match(modal, /useDialogFocus\(requestClose/);
  assert.match(modal, /role="dialog" aria-modal="true"/);
  assert.match(modal, /JSON.stringify\(form\) !== JSON.stringify\(savedForm\)/);
  assert.doesNotMatch(modal, /onClick=\{onClose\}/);
  assert.match(modal, /全局音量已保存，但人设与音色未完成保存/);
});

test("firmware progress survives expected USB disappearance", () => {
  assert.match(read("./shell/FirmwareUpdateNavItem.jsx"), /pending \|\| disposition === "update"/);
  assert.match(read("./shell/FirmwareUpdateNavItem.jsx"), /completed\?\.boardDeviceId === usb.boardDeviceId/);
  assert.match(read("./shell/FirmwareUpdateNavItem.jsx"), /validate:"确认版本"/);
});

test("cancelled native exit never stops background runtimes", () => {
  const native=read("../src-tauri/src/lib.rs");
  const exit=native.slice(native.indexOf("app.run(|app_handle, event|"),native.indexOf("#[cfg(all(target_os",native.indexOf("app.run(|app_handle, event|")));
  assert.match(exit,/RunEvent::ExitRequested[\s\S]*?request_exit\(app_handle\)\{api.prevent_exit\(\);\}/);
  assert.match(exit,/RunEvent::Exit => stop_background_runtimes_on_exit\(\)/);
  assert.equal(exit.match(/stop_background_runtimes_on_exit/g).length,1);
});

test("API configured badges count persisted values, not unsaved input", () => {
  const source = read("./ApiSettings.jsx");
  assert.match(source, /providerCredentialsConfigured\(provider.id, savedVideoConfigs\[provider.id\]\)/);
  assert.doesNotMatch(source, /providerCredentialsConfigured\(provider.id, videoConfigs\[provider.id\]\)/);
  assert.ok(source.indexOf('saveProviderConfig(providerId, persistedProviderConfig(config))')
    < source.indexOf('setSavedVideoConfigs(current'));
});

test("async credential persistence cannot admit duplicate single-state generations", () => {
  const source=read("./AppearanceDetail.jsx");
  const generation = source.slice(source.indexOf("const handleSingleStateGenerate"), source.indexOf("const handleSyncSingleStateToDevice"));
  assert.match(generation, /singleSubmitting.current \|\| operationBusy/);
  assert.match(source, /operationBusy = [^;]*singleStateStatus === "generating"/);
  assert.ok(generation.indexOf("if (!beginOperation()) return") < generation.indexOf("singleSubmitting.current = true"));
  assert.ok(generation.indexOf("singleSubmitting.current = true") < generation.indexOf("await persistSingleStateProviderConfig()"));
  assert.match(generation, /catch \(error\) \{[\s\S]*?singleSubmitting.current = false;\s*endOperation\(\);/);
  assert.match(generation, /finally \{\s*singleSubmitting.current = false;\s*endOperation\(\);\s*setExitReason\(exitId,""\)/);
  const wizard=read("./CustomAvatarWizard.jsx");
  assert.ok(wizard.indexOf("if (!mountedRef.current)") < wizard.indexOf("startGenerationTask({"));
});

test("default-appearance overrides are marked pending before they are written, matching the native marker", () => {
  const store = read("./lib/appearance-store.js");
  const native = read("../src-tauri/src/lib.rs");
  const marker = store.match(/BUILTIN_PREPARE_PENDING_FILE = "([^"]+)"/)[1];
  assert.match(native, new RegExp(`const BUILTIN_PREPARE_PENDING: &str = "${marker}";`));
  for (const writer of ["writeBuiltinAudioOverrides", "writeBuiltinVideoOverrides"]) {
    const start = store.indexOf(`async function ${writer}`);
    const body = store.slice(start, store.indexOf("\n}\n", start));
    assert.ok(body.includes("await markBuiltinPreparePending()"), writer);
    assert.ok(body.indexOf("await markBuiltinPreparePending()") < body.indexOf("await writeTextFile"), writer);
  }
});
