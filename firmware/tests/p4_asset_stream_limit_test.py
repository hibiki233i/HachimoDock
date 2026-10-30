"""Exercise the real manifest parser at the P4 stream-size boundary."""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]

def test_stream_limit_boundary():
    with tempfile.TemporaryDirectory() as directory:
        tmp = pathlib.Path(directory)
        (tmp / 'esp_heap_caps.h').write_text('''#include <stdlib.h>\n#define MALLOC_CAP_SPIRAM 0\n#define MALLOC_CAP_8BIT 0\n#define heap_caps_calloc(n,s,c) calloc(n,s)\n#define heap_caps_free(p) free(p)\n''')
        (tmp / 'test.c').write_text('''#include "pet_p4_assets.h"\n#include <assert.h>\nint main(void) {\n  pet_p4_asset_catalog_t catalog;\n  assert(pet_p4_asset_catalog_parse(&catalog, "{\\"format\\":\\"p4-h264-v1\\",\\"families\\":[{\\"family\\":\\"idle\\",\\"path\\":\\"p4/idle.h264\\",\\"frames\\":1,\\"streamBytes\\":2097152}]}"));\n  assert(!pet_p4_asset_catalog_parse(&catalog, "{\\"format\\":\\"p4-h264-v1\\",\\"families\\":[{\\"family\\":\\"idle\\",\\"path\\":\\"p4/idle.h264\\",\\"frames\\":1,\\"streamBytes\\":2097153}]}"));\n}\n''')
        subprocess.run(['cc', '-I', str(tmp), '-I', str(ROOT / 'main'), str(tmp / 'test.c'), str(ROOT / 'main/pet_p4_assets.c'), '-o', str(tmp / 'test')], check=True)
        subprocess.run([str(tmp / 'test')], check=True)
