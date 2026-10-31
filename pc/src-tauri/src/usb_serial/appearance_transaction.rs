/*
 * [Input] Prepared appearance assets, remote stats/slots, and asset OTA errors.
 * [Output] Integrity digests, sync plans, slot fallback, ACK policy, and stable pack IDs.
 * [Pos] Pure appearance transaction contract beneath usb_serial.rs.
 * [Sync] If this file changes, update `pc/.folder.md`.
 */

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};

const FNV1A64_OFFSET: u64 = 0xcbf29ce484222325;
const FNV1A64_PRIME: u64 = 0x00000100000001b3;
pub(super) const P4_BUILTIN_APPEARANCE_SLOT: u32 = 0;
pub(super) const P4_RAW_APPEARANCE_SLOT: u32 = 1;

#[derive(Debug, Clone)]
pub(super) struct AppearanceAssetEntry {
    pub(super) family_name: String,
    pub(super) kind: &'static str,
    pub(super) source_path: PathBuf,
    pub(super) device_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AppearanceAssetDigest {
    pub(super) kind: &'static str,
    pub(super) device_path: String,
    pub(super) size: u64,
    pub(super) checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AssetRemoteStat {
    pub(super) size: u64,
    pub(super) checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct P4AppearanceSlot {
    pub(super) slot: u32,
    pub(super) pack_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct P4AppearanceSlotState {
    pub(super) active_slot: Option<u32>,
    pub(super) slots: Vec<P4AppearanceSlot>,
}

/// Outcome of looking for an exact pack among the board's slots; the slot says where it lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum P4CachedPackActivation {
    NotFound,
    AlreadyActive(u32),
    Activated(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum AppearanceSyncPlan {
    Full,
    AudioPatch(Vec<String>),
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AppearanceFullSyncMode {
    Verified,
    LegacyCommitOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AppearanceAssetAckPhase {
    Begin,
    Stat,
    File,
    Patch,
    Commit,
}

pub(super) fn asset_checksum_hex(bytes: &[u8]) -> String {
    let checksum = fnv1a64_update(FNV1A64_OFFSET, bytes);
    format!("{checksum:016x}")
}

fn fnv1a64_update(mut checksum: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        checksum ^= u64::from(*byte);
        checksum = checksum.wrapping_mul(FNV1A64_PRIME);
    }
    checksum
}

pub(super) fn digest_appearance_assets(
    assets: &[AppearanceAssetEntry],
) -> Result<Vec<AppearanceAssetDigest>, String> {
    assets.iter().map(digest_appearance_asset).collect()
}

fn digest_appearance_asset(asset: &AppearanceAssetEntry) -> Result<AppearanceAssetDigest, String> {
    let bytes = std::fs::read(&asset.source_path).map_err(|error| {
        let label = if asset.kind == "audio" {
            "读取音效失败"
        } else {
            "读取视频失败"
        };
        format!("{} {}: {}", label, asset.family_name, error)
    })?;
    Ok(AppearanceAssetDigest {
        kind: asset.kind,
        device_path: asset.device_path.clone(),
        size: bytes.len() as u64,
        checksum: asset_checksum_hex(&bytes),
    })
}

pub(super) fn plan_appearance_sync_from_digests(
    local: &[AppearanceAssetDigest],
    remote: &HashMap<String, AssetRemoteStat>,
    remote_has_removed_audio: bool,
) -> AppearanceSyncPlan {
    for asset in local.iter().filter(|asset| asset.kind != "audio") {
        let Some(stat) = remote.get(&asset.device_path) else {
            return AppearanceSyncPlan::Full;
        };
        if stat.size != asset.size || stat.checksum != asset.checksum {
            return AppearanceSyncPlan::Full;
        }
    }

    if remote_has_removed_audio {
        return AppearanceSyncPlan::Full;
    }

    let changed_audio = local
        .iter()
        .filter(|asset| asset.kind == "audio")
        .filter_map(|asset| {
            let stat = remote.get(&asset.device_path)?;
            if stat.size == asset.size && stat.checksum == asset.checksum {
                None
            } else {
                Some(asset.device_path.clone())
            }
        })
        .chain(
            local
                .iter()
                .filter(|asset| asset.kind == "audio" && !remote.contains_key(&asset.device_path))
                .map(|asset| asset.device_path.clone()),
        )
        .collect::<Vec<_>>();

    if changed_audio.is_empty() {
        AppearanceSyncPlan::Skip
    } else {
        AppearanceSyncPlan::AudioPatch(changed_audio)
    }
}

pub(super) fn build_asset_file_commit_payload(
    transfer_id: &str,
    path: &str,
    size: u64,
    checksum: &str,
    chunk_count: u64,
) -> Value {
    serde_json::json!({
        "transferId": transfer_id,
        "path": path,
        "size": size,
        "checksum": checksum,
        "chunkCount": chunk_count,
    })
}

pub(super) fn parse_p4_appearance_slot_state(
    payload: &Value,
) -> Result<P4AppearanceSlotState, String> {
    let active_slot = payload
        .get("activeSlot")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    let slots = payload
        .get("slots")
        .and_then(Value::as_array)
        .ok_or_else(|| "P4 slot query response does not contain slots".to_string())?
        .iter()
        .filter(|slot| slot.get("valid").and_then(Value::as_bool).unwrap_or(true))
        .filter_map(|slot| {
            let slot_index = slot
                .get("slot")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())?;
            let pack_id = slot
                .get("packId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())?;
            Some(P4AppearanceSlot {
                slot: slot_index,
                pack_id: pack_id.to_string(),
            })
        })
        .collect();
    Ok(P4AppearanceSlotState { active_slot, slots })
}

/// Raw video capacities per slot (`appearance.slotCapacityBytes`, 0 = no such partition).
/// `None` means firmware that predates multiple slots: only the legacy custom slot exists.
pub(super) fn parse_p4_slot_capacities(capabilities: &Value) -> Option<Vec<u64>> {
    let list = capabilities
        .get("appearance")?
        .get("slotCapacityBytes")?
        .as_array()?;
    Some(list.iter().map(|value| value.as_u64().unwrap_or(0)).collect())
}

pub(crate) const P4_APPEARANCE_SLOTS_FULL_ERROR: &str = "P4_APPEARANCE_SLOTS_FULL";

/// Pick the slot a new pack is written to.
///
/// 1. Only slots that exist and can hold `raw_bytes` of video qualify.
/// 2. The slot this appearance used last time wins, so re-syncing an edited appearance replaces
///    its own copy instead of consuming another slot.
/// 3. Otherwise the lowest empty slot.
/// 4. Otherwise the slot synced longest ago, never the one currently shown unless it is the only
///    choice. Slots with no record (factory defaults) count as oldest.
/// Preloads disable replacement: an occupied preferred slot never bypasses the empty-slot rule.
pub(super) fn choose_p4_target_slot(
    state: &P4AppearanceSlotState,
    capacities: Option<&[u64]>,
    raw_bytes: u64,
    preferred: Option<u32>,
    synced_at: &HashMap<u32, u64>,
    allow_replacement: bool,
) -> Result<u32, String> {
    let Some(capacities) = capacities else {
        if !allow_replacement && state.slots.iter().any(|slot| slot.slot == P4_RAW_APPEARANCE_SLOT) {
            return Err(P4_APPEARANCE_SLOTS_FULL_ERROR.into());
        }
        return Ok(P4_RAW_APPEARANCE_SLOT);
    };
    let candidates: Vec<u32> = (0..capacities.len() as u32)
        .filter(|slot| {
            let capacity = capacities[*slot as usize];
            capacity > 0 && raw_bytes <= capacity
        })
        .collect();
    if candidates.is_empty() {
        let largest = capacities.iter().copied().max().unwrap_or(0);
        return Err(format!(
            "P4 appearance videos require {raw_bytes} bytes but the largest slot only has {largest} bytes"
        ));
    }
    let occupied = |slot: u32| state.slots.iter().any(|entry| entry.slot == slot);
    if let Some(slot) = preferred.filter(|slot| candidates.contains(slot) && (allow_replacement || !occupied(*slot))) {
        return Ok(slot);
    }
    if let Some(slot) = candidates.iter().copied().find(|slot| !occupied(*slot)) {
        return Ok(slot);
    }
    if !allow_replacement { return Err(P4_APPEARANCE_SLOTS_FULL_ERROR.into()); }
    Ok(candidates
        .iter()
        .copied()
        .filter(|slot| state.active_slot != Some(*slot))
        .min_by_key(|slot| (synced_at.get(slot).copied().unwrap_or(0), *slot))
        .unwrap_or(candidates[0]))
}

/// While `target` is rewritten the board must not be left showing it: when it is the active slot,
/// activate any other slot that holds a valid pack first.
pub(super) fn p4_transfer_fallback_slot(
    state: &P4AppearanceSlotState,
    target: u32,
) -> Option<&P4AppearanceSlot> {
    if state.active_slot != Some(target) {
        return None;
    }
    state.slots.iter().find(|slot| slot.slot != target)
}

const P4_SLOT_ASSIGNMENTS_FILE: &str = "p4-slot-assignments.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct P4SlotAssignment {
    pub(super) appearance_id: String,
    pub(super) synced_at_ms: u64,
}

/// Which appearance last went into which slot of which board. The board only knows pack ids, so
/// this is what lets a re-sync reuse a slot and lets eviction pick the stalest one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct P4SlotAssignments {
    boards: BTreeMap<String, BTreeMap<u32, P4SlotAssignment>>,
}

impl P4SlotAssignments {
    pub(super) fn load(app_data_dir: &Path) -> Self {
        std::fs::read(app_data_dir.join(P4_SLOT_ASSIGNMENTS_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub(super) fn save(&self, app_data_dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        let temporary = tempfile::NamedTempFile::new_in(app_data_dir).map_err(|error| error.to_string())?;
        std::fs::write(temporary.path(), bytes).map_err(|error| error.to_string())?;
        temporary
            .persist(app_data_dir.join(P4_SLOT_ASSIGNMENTS_FILE))
            .map_err(|error| error.error.to_string())?;
        Ok(())
    }

    pub(super) fn preferred_slot(&self, board: &str, appearance_id: &str) -> Option<u32> {
        self.boards
            .get(board)?
            .iter()
            .find(|(_, entry)| entry.appearance_id == appearance_id)
            .map(|(slot, _)| *slot)
    }

    pub(super) fn synced_at(&self, board: &str) -> HashMap<u32, u64> {
        self.boards
            .get(board)
            .map(|slots| slots.iter().map(|(slot, entry)| (*slot, entry.synced_at_ms)).collect())
            .unwrap_or_default()
    }

    /// `slot` now holds `appearance_id`; any older slot of the same appearance is forgotten.
    pub(super) fn record(&mut self, board: &str, slot: u32, appearance_id: &str, now_ms: u64) {
        let slots = self.boards.entry(board.to_string()).or_default();
        slots.retain(|_, entry| entry.appearance_id != appearance_id);
        slots.insert(
            slot,
            P4SlotAssignment { appearance_id: appearance_id.to_string(), synced_at_ms: now_ms },
        );
    }
}

// A protected factory appearance is addressed by its slot identity, not the
// desktop bundle hash (which may differ after audio-only product updates).
pub(super) fn p4_builtin_slot(state: &P4AppearanceSlotState) -> Result<&P4AppearanceSlot, String> {
    state.slots.iter().find(|slot| slot.slot == P4_BUILTIN_APPEARANCE_SLOT)
        .ok_or_else(|| "设备内置形象不可用；请修复出厂素材。未覆盖自定义形象，也未自动重传。".to_string())
}

pub(super) fn parse_missing_asset_ack_phase(error: &str) -> Option<AppearanceAssetAckPhase> {
    if !error.contains("未收到板端素材 OTA 确认:") {
        return None;
    }
    if error.contains("phase=begin") {
        return Some(AppearanceAssetAckPhase::Begin);
    }
    if error.contains("phase=stat") {
        return Some(AppearanceAssetAckPhase::Stat);
    }
    if error.contains("phase=file") {
        return Some(AppearanceAssetAckPhase::File);
    }
    if error.contains("phase=patch") {
        return Some(AppearanceAssetAckPhase::Patch);
    }
    if error.contains("phase=commit") {
        return Some(AppearanceAssetAckPhase::Commit);
    }
    None
}

pub(super) fn should_retry_appearance_with_legacy_full_sync(error: &str) -> bool {
    matches!(
        parse_missing_asset_ack_phase(error),
        Some(
            AppearanceAssetAckPhase::Stat
                | AppearanceAssetAckPhase::File
                | AppearanceAssetAckPhase::Patch
        )
    )
}

pub(super) fn compute_p4_pack_id(
    assets: &[AppearanceAssetEntry],
    manifest_identity: &[u8],
) -> Result<String, String> {
    let mut ordered = assets.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.device_path.cmp(&right.device_path));
    let mut digest = Sha256::new();
    digest.update(b"pet-manager-p4-pack-v1\0");
    digest.update((manifest_identity.len() as u64).to_le_bytes());
    digest.update(manifest_identity);
    for asset in ordered {
        let path = asset.device_path.as_bytes();
        digest.update((path.len() as u64).to_le_bytes());
        digest.update(path);
        let mut file = std::fs::File::open(&asset.source_path).map_err(|error| {
            format!(
                "open P4 pack asset failed {}: {}",
                asset.source_path.display(),
                error
            )
        })?;
        let size = file
            .metadata()
            .map_err(|error| {
                format!(
                    "stat P4 pack asset failed {}: {}",
                    asset.source_path.display(),
                    error
                )
            })?
            .len();
        digest.update(size.to_le_bytes());
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|error| {
                format!(
                    "read P4 pack asset failed {}: {}",
                    asset.source_path.display(),
                    error
                )
            })?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(super) fn p4_pack_id_from_assets(assets: &[AppearanceAssetEntry]) -> Result<String, String> {
    let manifest = assets
        .iter()
        .find(|asset| asset.device_path == "p4/manifest.json")
        .ok_or_else(|| "P4 pack manifest is missing".to_string())?;
    let value: Value = serde_json::from_slice(
        &std::fs::read(&manifest.source_path)
            .map_err(|error| format!("read P4 pack manifest failed: {error}"))?,
    )
    .map_err(|error| format!("parse P4 pack manifest failed: {error}"))?;
    value
        .get("packId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "P4 pack manifest does not contain packId".to_string())
}
