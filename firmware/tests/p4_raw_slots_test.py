"""Compile the real raw appearance storage against RAM-backed partitions.

Input: main/pet_p4_raw_assets.c with stub ESP partition and FreeRTOS headers; the three slots of the shipped table exist.
Output: regression checks that each slot is written, committed, read and invalidated independently,
        that a missing partition is refused before anything is erased, and that capacities per slot
        come from the partition table.
Position: pytest wrapper for the multi-slot raw storage; the flash driver itself is not compiled.
Sync: update with pet_p4_raw_assets.c/.h, partitions.csv and protocol.md.
"""

from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]

ESP_PARTITION_H = r"""#pragma once
#include <stddef.h>
#include <stdint.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL (-1)
typedef enum { ESP_PARTITION_TYPE_DATA = 1 } esp_partition_type_t;
typedef enum { ESP_PARTITION_SUBTYPE_ANY = 0xff } esp_partition_subtype_t;
typedef struct { uint32_t address; uint32_t size; char label[17]; } esp_partition_t;
const esp_partition_t *esp_partition_find_first(esp_partition_type_t, esp_partition_subtype_t, const char *label);
esp_err_t esp_partition_read(const esp_partition_t *, size_t offset, void *dst, size_t size);
esp_err_t esp_partition_write(const esp_partition_t *, size_t offset, const void *src, size_t size);
esp_err_t esp_partition_erase_range(const esp_partition_t *, size_t offset, size_t size);
"""

FREERTOS_H = "#pragma once\n#define pdMS_TO_TICKS(ms) (ms)\n"
TASK_H = "#pragma once\nstatic inline void vTaskDelay(int ticks) { (void) ticks; }\n"

HARNESS = r"""#include "pet_p4_raw_assets.h"
#include "esp_partition.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SLOT_BYTES 0x40000U
#define FLASH_BYTES (4U * SLOT_BYTES)
static unsigned char g_flash[FLASH_BYTES];
static esp_partition_t g_parts[4];

#define CHECK(cond) do { if (!(cond)) { printf("FAIL line %d: %s\n", __LINE__, #cond); exit(1); } } while (0)

const esp_partition_t *esp_partition_find_first(esp_partition_type_t t, esp_partition_subtype_t s, const char *label) {
  (void) t; (void) s;
  for (int i = 0; i < 3; i += 1) {  /* the table has no appearance3 */
    if (strcmp(g_parts[i].label, label) == 0) return &g_parts[i];
  }
  return NULL;
}
esp_err_t esp_partition_read(const esp_partition_t *p, size_t off, void *dst, size_t n) {
  if (off + n > p->size) return ESP_FAIL;
  memcpy(dst, g_flash + p->address + off, n);
  return ESP_OK;
}
esp_err_t esp_partition_write(const esp_partition_t *p, size_t off, const void *src, size_t n) {
  if (off + n > p->size) return ESP_FAIL;
  for (size_t i = 0; i < n; i += 1) g_flash[p->address + off + i] &= ((const unsigned char *) src)[i];
  return ESP_OK;
}
esp_err_t esp_partition_erase_range(const esp_partition_t *p, size_t off, size_t n) {
  if (off + n > p->size) return ESP_FAIL;
  memset(g_flash + p->address + off, 0xff, n);
  return ESP_OK;
}

static const char *PACK_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static const char *PACK_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
static const char *PATH = "p4/families/idle.h264";

/* `peek` reads the slot mid-transfer, which caches "no pack" and must not survive the commit. */
static bool store(int slot, const char *pack_id, unsigned char fill, size_t len, bool peek) {
  unsigned char data[300];
  char error[128];
  char peeked[65];
  memset(data, fill, sizeof(data));
  if (!pet_p4_raw_assets_prepare(slot, 0, error, sizeof(error))) return false;
  if (!pet_p4_raw_assets_write_chunk(PATH, "0", data, len, error, sizeof(error))) return false;
  if (!pet_p4_raw_assets_finish_file(PATH, len, NULL, error, sizeof(error))) return false;
  if (peek && pet_p4_raw_assets_committed_pack_id_for_slot(slot, peeked, sizeof(peeked))) return false;
  return pet_p4_raw_assets_commit(pack_id, error, sizeof(error));
}

static bool holds(int slot, const char *pack_id, unsigned char fill, size_t len) {
  char id[65];
  unsigned char out[300];
  if (!pet_p4_raw_assets_committed_pack_id_for_slot(slot, id, sizeof(id)) || strcmp(id, pack_id) != 0) return false;
  if (!pet_p4_raw_assets_read_all_from_slot(slot, PATH, out, len)) return false;
  for (size_t i = 0; i < len; i += 1) if (out[i] != fill) return false;
  return true;
}

int main(void) {
  char error[128];
  char id[65];
  unsigned char out[300];
  memset(g_flash, 0xff, sizeof(g_flash));
  for (int i = 0; i < 4; i += 1) {
    snprintf(g_parts[i].label, sizeof(g_parts[i].label), "appearance%d", i);
    g_parts[i].address = (uint32_t) i * SLOT_BYTES;
    g_parts[i].size = SLOT_BYTES;
  }

  CHECK(pet_p4_raw_assets_available_slot_count() == 3);
  CHECK(pet_p4_raw_assets_slot_capacity_bytes(0) == SLOT_BYTES - 4096U);
  CHECK(pet_p4_raw_assets_slot_capacity_bytes(2) == SLOT_BYTES - 4096U);
  CHECK(pet_p4_raw_assets_slot_capacity_bytes(3) == 0);
  CHECK(!pet_p4_raw_assets_slot_available(3));
  CHECK(!pet_p4_raw_assets_slot_available(4));

  /* Slot 2 can be written without touching slots 0 or 1. */
  CHECK(store(2, PACK_A, 0xA1, 200, false));
  CHECK(holds(2, PACK_A, 0xA1, 200));
  CHECK(!pet_p4_raw_assets_committed_pack_id_for_slot(1, id, sizeof(id)));
  CHECK(!pet_p4_raw_assets_committed_pack_id_for_slot(0, id, sizeof(id)));
  CHECK(!pet_p4_raw_assets_read_all_from_slot(1, PATH, out, 200));

  /* A second pack in slot 1 leaves slot 2 intact, and erasing slot 1 again does too. */
  CHECK(store(1, PACK_B, 0xB2, 150, false));
  CHECK(holds(1, PACK_B, 0xB2, 150));
  CHECK(holds(2, PACK_A, 0xA1, 200));
  CHECK(store(1, PACK_B, 0xC3, 120, false));
  CHECK(holds(1, PACK_B, 0xC3, 120));
  CHECK(holds(2, PACK_A, 0xA1, 200));

  /* The same pack id in two slots stays two independent copies. */
  CHECK(store(0, PACK_A, 0xD4, 100, false));
  CHECK(holds(0, PACK_A, 0xD4, 100));
  CHECK(holds(2, PACK_A, 0xA1, 200));

  /* A slot without a partition is refused with nothing erased. */
  CHECK(!pet_p4_raw_assets_prepare(3, 0, error, sizeof(error)));
  CHECK(strstr(error, "not found") != NULL);
  CHECK(!pet_p4_raw_assets_prepare(-1, 0, error, sizeof(error)));
  CHECK(holds(2, PACK_A, 0xA1, 200));

  /* After a commit the transfer is closed: a stray chunk is refused. */
  CHECK(!pet_p4_raw_assets_write_chunk(PATH, "0", out, 10, error, sizeof(error)));

  /* An oversized pack is refused for the slot that cannot hold it. */
  CHECK(!pet_p4_raw_assets_prepare(2, (unsigned long long) SLOT_BYTES, error, sizeof(error)));
  CHECK(strstr(error, "exceeds") != NULL);

  /* Invalidating one slot leaves the others valid. */
  CHECK(pet_p4_raw_assets_invalidate(2, error, sizeof(error)));
  CHECK(!pet_p4_raw_assets_committed_pack_id_for_slot(2, id, sizeof(id)));
  CHECK(holds(1, PACK_B, 0xC3, 120));
  CHECK(holds(0, PACK_A, 0xD4, 100));

  /* A slot read during its own transfer must show the new pack after the commit, not a cached miss. */
  CHECK(store(2, PACK_B, 0xE5, 90, true));
  CHECK(holds(2, PACK_B, 0xE5, 90));
  CHECK(holds(1, PACK_B, 0xC3, 120));

  puts("OK");
  return 0;
}
"""


@pytest.fixture(scope="module")
def raw_slots_binary(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("p4_raw_slots")
    (tmp / "freertos").mkdir()
    (tmp / "esp_partition.h").write_text(ESP_PARTITION_H)
    (tmp / "freertos/FreeRTOS.h").write_text(FREERTOS_H)
    (tmp / "freertos/task.h").write_text(TASK_H)
    (tmp / "harness.c").write_text(HARNESS)
    subprocess.run(
        ["cc", "-Wall", "-Werror", "-I", str(tmp), "-I", str(ROOT / "main"), str(tmp / "harness.c"),
         str(ROOT / "main/pet_p4_raw_assets.c"), "-o", str(tmp / "harness")],
        check=True,
    )
    return tmp / "harness"


def test_each_raw_slot_is_written_committed_read_and_invalidated_independently(raw_slots_binary):
    result = subprocess.run([str(raw_slots_binary)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "OK"
