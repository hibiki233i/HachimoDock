/*
 * [Input] P4 MJPEG/H.264 logical paths and transaction chunks for the dedicated raw flash partition.
 * [Output] Bounded append-only per-slot writes, commit-last index headers, and direct reads for up to PET_P4_APPEARANCE_SLOT_COUNT partitions.
 * [Pos] High-throughput appearance storage backend for ESP32-P4.
 * [Sync] If this file changes, update protocol.md and firmware/.folder.md.
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PET_P4_BUILTIN_APPEARANCE_SLOT 0
#define PET_P4_RAW_APPEARANCE_SLOT 1
/* Slots 0..N-1 map to partitions appearance0..appearance{N-1}; a slot without a partition is unavailable. */
#define PET_P4_APPEARANCE_SLOT_COUNT 3
/* Every slot is an ordinary writable slot; the factory image only preloads default packs into them. */
#define PET_P4_BUILTIN_SLOT_PROTECTED 0

bool pet_p4_raw_assets_available(void);
unsigned long long pet_p4_raw_assets_capacity_bytes(void);
bool pet_p4_raw_assets_slot_available(int slot);
unsigned long long pet_p4_raw_assets_slot_capacity_bytes(int slot);
int pet_p4_raw_assets_available_slot_count(void);
bool pet_p4_raw_assets_supports_path(const char *logical_path);
bool pet_p4_raw_assets_prepare(
  int slot,
  unsigned long long total_bytes,
  char *error,
  size_t error_size
);
bool pet_p4_raw_assets_write_chunk(
  const char *logical_path,
  const char *index,
  const unsigned char *data,
  size_t data_len,
  char *error,
  size_t error_size
);
bool pet_p4_raw_assets_finish_file(
  const char *logical_path,
  unsigned long long expected_size,
  const char *expected_checksum,
  char *error,
  size_t error_size
);
bool pet_p4_raw_assets_commit(
  const char *pack_id,
  char *error,
  size_t error_size
);
bool pet_p4_raw_assets_invalidate(int slot, char *error, size_t error_size);
void pet_p4_raw_assets_reset_transfer(void);
bool pet_p4_raw_assets_committed_pack_id(char *out, size_t out_size);
bool pet_p4_raw_assets_committed_pack_id_for_slot(
  int slot,
  char *out,
  size_t out_size
);
bool pet_p4_raw_assets_read_all(
  const char *logical_path,
  unsigned char *out,
  size_t expected_size
);
bool pet_p4_raw_assets_read_all_from_slot(
  int slot,
  const char *logical_path,
  unsigned char *out,
  size_t expected_size
);

#ifdef __cplusplus
}
#endif
