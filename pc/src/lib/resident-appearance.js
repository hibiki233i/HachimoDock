/**
 * [Input] A Tauri `invoke` adapter, an appearance id and the bound board id.
 * [Output] Resident activation and non-replacing USB preloading with serialized device writes, actual-slot restoration, latest-focus confirmation and a report of each pet put on the board.
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

/** Preload over USB without replacing a resident pack; the backend restores the actual active slot. */
export async function preloadResidentAppearance({ invoke, appearanceId, boardDeviceId = "" }) {
  if (typeof invoke !== "function" || !appearanceId) {
    return { ok: false, transferred: false, error: "缺少桌宠或设备信息" };
  }
  try {
    const result = await invoke("usb_sync_appearance", { appearanceId, boardDeviceId: boardDeviceId || null, preloadOnly: true });
    if (result?.slotsFull) return { ok: false, ignored: true, state: "slotsFull", transferred: false };
    if (!result?.ok) return { ok: false, transferred: false, error: String(result?.error || "预载失败") };
    return { ok: true, transferred: Number(result.byteCount) > 0, restored: true };
  } catch (error) {
    return { ok: false, transferred: false, error: String(error?.message || error) };
  }
}

/** Serialize focus changes and preloads, then reconcile the latest target after each device write. */
export function createPetFollowController({ invoke, onNotice, onShown }) {
  let target = { enabled: false, boardDeviceId: "", appearanceId: "" };
  let shown = { boardDeviceId: "", appearanceId: "" };
  let pending = Promise.resolve();
  const warned = new Set();

  function enqueue(operation) {
    const request = pending.catch(() => {}).then(operation);
    pending = request;
    return request;
  }

  function warn(appearanceId, outcome) {
    const message = residentActivationMessage(outcome);
    const key = `${appearanceId}:${outcome.state}`;
    if (message && !warned.has(key)) {
      warned.add(key);
      onNotice?.({ tone: "warning", title: message });
    }
  }

  async function reconcile() {
    while (target.enabled && target.appearanceId) {
      const requested = { ...target };
      if (shown.boardDeviceId === requested.boardDeviceId && shown.appearanceId === requested.appearanceId) return true;
      const outcome = await activateResidentAppearance({ invoke, ...requested });
      if (outcome.ok) {
        // A completed request changed the board even if the focus changed while it was in flight.
        shown = requested;
        onShown?.(requested);
      } else if (target.boardDeviceId === requested.boardDeviceId && target.appearanceId === requested.appearanceId) {
        warn(requested.appearanceId, outcome);
        return false;
      }
    }
    return true;
  }

  return {
    invalidateShownAppearance() { shown = { boardDeviceId: "", appearanceId: "" }; },
    setTarget(value) {
      target = { ...value };
      return enqueue(reconcile);
    },
    preload({ appearanceId, boardDeviceId }) {
      return enqueue(async () => {
        const outcome = await preloadResidentAppearance({ invoke, appearanceId, boardDeviceId });
        if (outcome.ignored) return outcome;
        // The backend restores the actual slot, which may differ from any frontend cache.
        shown = { boardDeviceId: "", appearanceId: "" };
        const restored = await reconcile();
        return outcome.ok ? { ...outcome, restored } : outcome;
      });
    },
  };
}
