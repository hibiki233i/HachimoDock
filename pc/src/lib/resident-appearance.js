/**
 * [Input] A Tauri `invoke` adapter, an appearance id and the bound board id.
 * [Output] Switch the board to an appearance already resident in one of its slots, and user-facing text for each outcome.
 * [Pos] lib node in pc/src/lib; used by focus-driven pet switching over USB or Wi-Fi.
 * [Sync] If this file changes, update `pc/src/.folder.md` and the `usb_activate_resident_appearance` command in `pc/src-tauri/src/lib.rs`.
 */

export const RESIDENT_STATE_ACTIVE = "active";
export const RESIDENT_STATE_ACTIVATED = "activated";
export const RESIDENT_STATE_NOT_RESIDENT = "notResident";

/** Never transfers assets: a pack that is not in a slot comes back as `notResident`, not as an error. */
export async function activateResidentAppearance({ invoke, appearanceId, boardDeviceId = "" }) {
  if (typeof invoke !== "function" || !appearanceId) {
    return { ok: false, state: "error", error: "缺少桌宠或设备信息" };
  }
  try {
    const result = await invoke("usb_activate_resident_appearance", {
      appearanceId,
      boardDeviceId: boardDeviceId || null,
    });
    return { ok: result?.ok === true, state: String(result?.state || "error") };
  } catch (error) {
    return { ok: false, state: "error", error: String(error?.message || error) };
  }
}

export function residentActivationMessage(outcome) {
  switch (outcome?.state) {
    case RESIDENT_STATE_ACTIVE:
    case RESIDENT_STATE_ACTIVATED:
      return "";
    case RESIDENT_STATE_NOT_RESIDENT:
      return "该桌宠还没有存入设备，请用 USB 连接并同步一次后再切换";
    default:
      return outcome?.error ? `切换桌宠失败：${outcome.error}` : "切换桌宠失败";
  }
}

/**
 * Make sure an appearance is stored on the board so it can be switched to later, then put back the
 * pet that was showing. A pack already in a slot is only activated; otherwise it is synced over
 * USB, which also makes it the displayed pet until `restoreAppearanceId` is activated again.
 */
export async function preloadResidentAppearance({ invoke, appearanceId, boardDeviceId = "", restoreAppearanceId = "" }) {
  if (typeof invoke !== "function" || !appearanceId) {
    return { ok: false, transferred: false, error: "缺少桌宠或设备信息" };
  }
  const present = await activateResidentAppearance({ invoke, appearanceId, boardDeviceId });
  let transferred = false;
  if (!present.ok) {
    if (present.state !== RESIDENT_STATE_NOT_RESIDENT) {
      return { ok: false, transferred: false, error: present.error || "无法确认设备上的桌宠" };
    }
    try {
      const result = await invoke("usb_sync_appearance", { appearanceId, boardDeviceId: boardDeviceId || null });
      if (result?.ok !== true) {
        return { ok: false, transferred: false, error: String(result?.error || "同步失败") };
      }
      transferred = true;
    } catch (error) {
      return { ok: false, transferred: false, error: String(error?.message || error) };
    }
  }
  if (restoreAppearanceId && restoreAppearanceId !== appearanceId) {
    // The target is stored either way; failing to switch back only leaves the other pet on screen.
    const restored = await activateResidentAppearance({ invoke, appearanceId: restoreAppearanceId, boardDeviceId });
    return { ok: true, transferred, restored: restored.ok };
  }
  return { ok: true, transferred, restored: true };
}

