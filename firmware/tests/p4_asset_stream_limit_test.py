"""Exercise the real manifest parser at the P4 per-stream size limit.

Host test: compiles main/pet_p4_assets.c with the system C compiler, like the other
firmware host tests, so it runs in the `firmware-host` CI job.
"""
import json
import pathlib
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIMIT = 2 * 1024 * 1024

HEAP_CAPS_STUB = """#include <stdlib.h>
#define MALLOC_CAP_SPIRAM 0
#define MALLOC_CAP_8BIT 0
#define heap_caps_calloc(n,s,c) calloc(n,s)
#define heap_caps_free(p) free(p)
"""

HARNESS = r"""#include "pet_p4_assets.h"
#include <stdio.h>

int main(int argc, char **argv) {
  static char manifest[8192];
  static pet_p4_asset_catalog_t catalog;
  FILE *file = argc > 1 ? fopen(argv[1], "rb") : NULL;
  if (!file) return 2;
  manifest[fread(manifest, 1, sizeof(manifest) - 1, file)] = '\0';
  fclose(file);
  int parsed = pet_p4_asset_catalog_parse(&catalog, manifest);
  printf("%d %u\n", parsed, parsed ? (unsigned) catalog.count : 0u);
  return 0;
}
"""


def h264_manifest(stream_bytes):
    return {
        "format": "p4-h264-v1",
        "families": [
            {"family": name, "path": f"p4/{name}.h264", "frames": 1, "streamBytes": size}
            for name, size in stream_bytes.items()
        ],
    }


def mjpeg_manifest(frame_sizes):
    return {
        "format": "p4-mjpeg-v1",
        "families": [
            {"family": name, "path": f"p4/{name}", "frames": len(sizes), "frameSizes": sizes}
            for name, sizes in frame_sizes.items()
        ],
    }


@pytest.fixture(scope="module")
def parse_catalog(tmp_path_factory):
    """Build the real parser once; return parse(manifest) -> (accepted, family_count)."""
    tmp = tmp_path_factory.mktemp("p4_catalog")
    (tmp / "esp_heap_caps.h").write_text(HEAP_CAPS_STUB)
    (tmp / "harness.c").write_text(HARNESS)
    subprocess.run(
        ["cc", "-I", str(tmp), "-I", str(ROOT / "main"), str(tmp / "harness.c"),
         str(ROOT / "main/pet_p4_assets.c"), "-o", str(tmp / "harness")],
        check=True,
    )

    def parse(manifest):
        path = tmp / "manifest.json"
        path.write_text(json.dumps(manifest))
        out = subprocess.run([str(tmp / "harness"), str(path)], check=True, capture_output=True, text=True)
        accepted, count = out.stdout.split()
        return accepted == "1", int(count)

    return parse


def test_stream_limit_boundary(parse_catalog):
    assert parse_catalog(h264_manifest({"idle": LIMIT})) == (True, 1)
    assert parse_catalog(h264_manifest({"idle": LIMIT + 1})) == (False, 0)


def test_catalog_with_every_stream_within_the_limit_parses(parse_catalog):
    assert parse_catalog(h264_manifest({"idle": 700_000, "working": LIMIT, "done": 1})) == (True, 3)


def test_one_oversized_stream_rejects_the_whole_catalog(parse_catalog):
    # The catalog is validated as a unit, so an appearance holding an action the renderer
    # cannot play is refused up front rather than failing partway through playback.
    assert parse_catalog(h264_manifest({"idle": 700_000, "working": LIMIT + 1, "done": 700_000})) == (False, 0)


def test_legacy_mjpeg_total_is_not_held_to_the_h264_stream_limit(parse_catalog):
    # The 2 MiB limit is for H.264 streams. A legacy MJPEG action is many small JPEG frames whose
    # total routinely exceeds it, and those packs must keep loading.
    frame_sizes = {"idle": [30_000] * 100}
    assert sum(frame_sizes["idle"]) > LIMIT
    assert parse_catalog(mjpeg_manifest(frame_sizes)) == (True, 1)
