"""Run the actual protocol marker functions against a temporary marker file."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ActiveSlotTest(unittest.TestCase):
    def test_all_three_slots_survive_reload_and_invalid_markers_are_ignored(self):
        source = (ROOT / "main/pet_p4_protocol.c").read_text()
        start = source.index("static bool slot_is_valid(")
        end = source.index("int pet_p4_asset_inactive_slot(", start)
        functions = source[start:end]
        harness = r"""#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#define PET_P4_ASSET_SLOT_COUNT 3
#define PET_P4_ASSET_SLOT_MARKER g_marker_path
static const char *g_marker_path;
static int g_asset_active_slot = -1;
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s\n", __LINE__, #x); return 1; } } while (0)
""" + functions + r"""
int main(int argc, char **argv) {
    (void) argc;
    g_marker_path = argv[1];
    for (int slot = 0; slot < 3; slot++) {
        CHECK(pet_p4_asset_set_active_slot(slot));
        g_asset_active_slot = -1; /* reboot: only the marker survives */
        CHECK(pet_p4_asset_active_slot() == slot);
    }
    const char *invalid[] = {"3\n", "9\n", "x\n", "/\n", "-1\n", ""};
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        FILE *f = fopen(g_marker_path, "wb");
        CHECK(f != NULL);
        fputs(invalid[i], f);
        fclose(f);
        g_asset_active_slot = -1;
        CHECK(pet_p4_asset_active_slot() == -1);
    }
    return 0;
}
"""
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            (tmp / "marker_test.c").write_text(harness)
            subprocess.run(["cc", "-Wall", "-Werror", str(tmp / "marker_test.c"), "-o", str(tmp / "marker_test")], check=True)
            result = subprocess.run([str(tmp / "marker_test"), str(tmp / "active-slot")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
