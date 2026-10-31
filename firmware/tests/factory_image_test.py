"""
[Input] Factory image sources, synthetic ready packs, and built-in P4 component packages.
[Output] Contract checks for hashing, H.264, per-slot default pet staging, sprite-complete
component preload/control mappings, layout, and export settings.
[Pos] Unit coverage for ESP32-P4 factory provisioning.
[Sync] If this file changes, update firmware/.folder.md.
"""

import importlib.util
import json
import re
import struct
import wave
import zlib
from pathlib import Path

import pytest


RUNTIME = Path(__file__).resolve().parents[1]
REPOSITORY = RUNTIME.parent
TOOL_PATH = RUNTIME / "tools" / "build_factory_image.py"
SPEC = importlib.util.spec_from_file_location("build_factory_image", TOOL_PATH)
factory = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(factory)


def test_bootstrap_and_launcher_follow_the_same_factory_catalog():
    config = json.loads((RUNTIME / "factory-config.json").read_text())
    ids = config["components"]["ids"]
    bundle = json.loads((RUNTIME / "main/pet_p4_builtin_components.json").read_text())
    assert [item["id"] for item in bundle["components"]] == ids
    launcher = (RUNTIME / "assets/component-center/catalog.h").read_text()
    assert re.findall(r'\{"([^\"]+)",', launcher) == ids
    thumbnails = zlib.decompress(
        (RUNTIME / "assets/component-center/center_thumbs.deflate").read_bytes()
    )
    assert len(thumbnails) == len(ids) * 64 * 48 * 2
    assert config["components"]["defaultActiveId"] in ids


def test_factory_hashes_match_firmware_filenames():
    assert factory.slot_file_name(0, "p4/manifest.json") == "s0_a8b42b148f04d84d"
    assert factory.slot_file_name(0, "p4/audio/done.wav") == "s0_add0927412aafb15"
    assert (
        factory.slot_file_name(
            0, "p4/families/sha256-0123456789abcdef01234567.h264"
        )
        == "s0_42234cdda81680ab"
    )


def minimal_stream(sps: bytes) -> bytes:
    return (
        b"\x00\x00\x00\x01"
        + sps
        + b"\x00\x00\x00\x01\x68\xce\x3c\x80"
        + b"\x00\x00\x00\x01\x09\xf0"
        + b"\x00\x00\x00\x01\x65\x88\x84"
    )


def test_factory_h264_parser_checks_baseline_level_and_geometry():
    sps = factory.p4_minimal_h264_sps(640, 480)
    assert sps.hex() == "6742c01eda0280f440"
    stream = minimal_stream(sps)
    assert factory.parse_p4_h264_stream(stream, 640, 480) == (1, len(stream))
    # The platform hardware encoder writes the same Baseline 3.0 640x480 stream with a different SPS.
    hardware = bytes.fromhex("2742c01eab40501ec8")
    assert factory.parse_sps_geometry(hardware) == (66, 30, 640, 480)
    assert factory.parse_p4_h264_stream(minimal_stream(hardware), 640, 480)[0] == 1
    multi_slice = stream + b"\x00\x00\x00\x01\x65\x88\x84"
    with pytest.raises(ValueError, match="exactly one slice"):
        factory.parse_p4_h264_stream(multi_slice, 640, 480)
    with pytest.raises(ValueError, match="SPS"):
        factory.parse_p4_h264_stream(minimal_stream(factory.p4_minimal_h264_sps(320, 240)), 640, 480)
    with pytest.raises(ValueError, match="SPS"):
        factory.parse_p4_h264_stream(minimal_stream(bytes([0x67, 77, 0xC0, 30]) + sps[4:]), 640, 480)


def test_factory_config_matches_desktop_export_contract_and_media():
    config = json.loads((RUNTIME / "factory-config.json").read_text(encoding="utf-8"))
    appearance = config["appearance"]
    desktop = (REPOSITORY / "pc" / "src-tauri" / "src" / "usb_serial.rs").read_text(
        encoding="utf-8"
    )
    expected = {
        "width": "P4_APPEARANCE_WIDTH",
        "height": "P4_APPEARANCE_HEIGHT",
        "fps": "P4_APPEARANCE_FPS",
        "maxFrames": "P4_APPEARANCE_MAX_FRAMES",
    }
    for key, constant in expected.items():
        match = re.search(rf"const {constant}: u32 = (\d+);", desktop)
        assert match, constant
        assert appearance[key] == int(match.group(1))
    prebuilder = (REPOSITORY / "pc/scripts/prepare-p4-ready-assets.mjs").read_text(encoding="utf-8")
    assert "String(appearance.h264Crf)" in prebuilder
    assert "appearance.readyProfile" in prebuilder
    assert appearance["readyProfile"] == (
        f"v9-{appearance['width']}x{appearance['height']}-"
        f"{appearance['fps']}fps-{appearance['maxFrames']}f-h264-crf{appearance['h264Crf']}"
    )
    assert appearance["readyProfile"] in desktop
    assert re.fullmatch(r"[0-9a-f]{64}", appearance["packId"])
    # The device default pets use the same export contract as the desktop's bundled appearance.
    assert config["appearanceContract"] == {
        "width": appearance["width"], "height": appearance["height"], "fps": appearance["fps"],
        "maxFrames": appearance["maxFrames"], "audioSampleRate": appearance["audioSampleRate"],
    }
    assert config["appearances"] == [], "third-party default pets belong in factory-config.local.json"

    clips = (RUNTIME / appearance["clipsDir"]).resolve()
    videos = sorted(clips.glob("*.mp4"))
    assert len(videos) == 16
    assert {"welcome", "idle.playing", "working.thinking", "done"} <= {
        path.stem for path in videos
    }
    assert all(path.stat().st_size > 0 for path in videos)


def test_desktop_bundled_pack_is_valid_but_no_longer_fits_a_five_mib_slot(tmp_path):
    config = json.loads((RUNTIME / "factory-config.json").read_text(encoding="utf-8"))
    appearance = config["appearance"]
    ready_root = (
        RUNTIME / appearance["clipsDir"] / "p4-ready" / appearance["readyProfile"]
    ).resolve()
    ready_manifest = json.loads(
        (ready_root / "p4" / "manifest.json").read_text(encoding="utf-8")
    )
    assert ready_manifest["format"] == "p4-h264-v1"
    assert ready_manifest["packId"] == appearance["packId"]
    for family in ready_manifest["families"]:
        frames, stream_bytes = factory.parse_p4_h264_stream(
            (ready_root / family["path"]).read_bytes(), appearance["width"], appearance["height"]
        )
        assert (frames, stream_bytes) == (family["frames"], family["streamBytes"])
    # Its ~8.6 MB of video was sized for the old 10 MiB slot; a 5 MiB slot refuses it before staging.
    (tmp_path / "out").mkdir()
    with pytest.raises(ValueError, match="exceeds appearance slot 0"):
        factory.build_default_appearance_tree(
            RUNTIME, tmp_path / "out",
            {"appearanceContract": config["appearanceContract"],
             "appearances": [{"id": "westie", "slot": 0, "readyRoot": str(ready_root)}]},
        )


CONTRACT = {"width": 640, "height": 480, "fps": 15, "maxFrames": 225, "audioSampleRate": 16000}


def synthetic_ready_pack(root, pack_id, families=("idle", "done"), audio=True, extra_bytes=0):
    """Write a minimal valid p4/ ready pack: one-frame streams, optional WAV cues, a manifest."""
    sps = factory.p4_minimal_h264_sps(640, 480)
    entries = []
    for index, family in enumerate(families):
        stream = minimal_stream(sps) + bytes([index]) + b"\x00" * extra_bytes
        path = root / "p4" / "families" / f"{family}.h264"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(stream)
        entry = {
            "family": family, "path": f"p4/families/{family}.h264", "frames": 1,
            "streamBytes": len(stream), "fps": 15, "frameDurationMs": 67, "durationMs": 67,
        }
        if audio:
            wav = root / "p4" / "audio" / f"{family}.wav"
            wav.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(wav), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(16000)
                handle.writeframes(b"\x00\x00" * 160)
            entry["audioPath"] = f"p4/audio/{family}.wav"
        entries.append(entry)
    manifest = {
        "format": "p4-h264-v1", "codec": "h264", "container": "annex-b",
        "width": 640, "height": 480, "fps": 15, "packId": pack_id, "families": entries,
    }
    (root / "p4" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def pets_config(*items):
    return {"appearanceContract": CONTRACT, "appearances": list(items)}


def test_each_default_pet_is_staged_in_its_own_slot(tmp_path):
    first = synthetic_ready_pack(tmp_path / "first", "a" * 64)
    second = synthetic_ready_pack(tmp_path / "second", "b" * 64, audio=False)
    out = tmp_path / "out"
    out.mkdir()
    summary = factory.build_default_appearance_tree(
        RUNTIME, out,
        pets_config(
            {"id": "pet-a", "slot": 2, "readyRoot": str(first)},
            {"id": "pet-b", "slot": 0, "readyRoot": str(second), "packId": "b" * 64},
        ),
    )
    tree = summary["tree"]
    assert (summary["count"], summary["activeSlot"], summary["families"]) == (2, 2, 4)
    assert (tree / factory.ACTIVE_SLOT_MARKER).read_text(encoding="ascii") == "2\n", "first listed pet shows first"
    for slot, pack_id in ((2, "a" * 64), (0, "b" * 64)):
        assert (tree / factory.SLOT_READY_MARKER_TEMPLATE.format(slot=slot)).read_text(encoding="ascii") == f"{pack_id}\n"
        stored = tree / factory.slot_file_name(slot, factory.P4_MANIFEST_LOGICAL_PATH)
        assert json.loads(stored.read_text(encoding="utf-8"))["packId"] == pack_id
    assert (tree / factory.slot_file_name(2, "p4/audio/idle.wav")).is_file()
    assert not (tree / factory.slot_file_name(0, "p4/audio/idle.wav")).exists()
    assert not (tree / factory.SLOT_READY_MARKER_TEMPLATE.format(slot=1)).exists(), "slot 1 stays empty"

    for pack, (offset, size) in zip(summary["packs"], ((0x1600000, 0x500000), (0xC00000, 0x500000))):
        image, image_offset, image_size = factory.build_raw_appearance_image(RUNTIME, out, pack)
        data = image.read_bytes()
        assert (image_offset, image_size, len(data)) == (offset, size, size)
        assert image.name == f"default.appearance{pack['slot']}.bin"
        assert data[:8] == b"P4RAW01\0"
        assert data[24:88] == pack["packId"].encode("ascii")
        assert struct.unpack_from("<I", data, 12)[0] == 2, "one video entry per family"


def test_a_factory_image_without_default_pets_has_no_active_pack(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    summary = factory.build_default_appearance_tree(RUNTIME, out, pets_config())
    assert (summary["count"], summary["activeSlot"], summary["packs"]) == (0, None, [])
    names = {path.name for path in summary["tree"].iterdir()}
    assert factory.ACTIVE_SLOT_MARKER not in names
    assert not any(name.endswith("_ready") for name in names)


def test_default_pet_staging_rejects_bad_inputs_before_writing_images(tmp_path):
    good = synthetic_ready_pack(tmp_path / "good", "c" * 64)
    out = tmp_path / "out"
    out.mkdir()

    with pytest.raises(ValueError, match="different slot"):
        factory.build_default_appearance_tree(RUNTIME, out, pets_config(
            {"id": "x", "slot": 1, "readyRoot": str(good)}, {"id": "y", "slot": 1, "readyRoot": str(good)}))
    with pytest.raises(ValueError, match="appearance3"):
        factory.build_default_appearance_tree(RUNTIME, out, pets_config(
            {"id": "x", "slot": 3, "readyRoot": str(good)}))
    with pytest.raises(ValueError, match="packId mismatch"):
        factory.build_default_appearance_tree(RUNTIME, out, pets_config(
            {"id": "x", "slot": 0, "readyRoot": str(good), "packId": "0" * 64}))
    with pytest.raises(FileNotFoundError, match="ready pack is missing"):
        factory.build_default_appearance_tree(RUNTIME, out, pets_config(
            {"id": "x", "slot": 0, "readyRoot": str(tmp_path / "nowhere")}))

    wrong_size = synthetic_ready_pack(tmp_path / "wrong", "d" * 64)
    manifest_path = wrong_size / "p4" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["width"] = 320
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="width mismatch"):
        factory.build_default_appearance_tree(RUNTIME, out, pets_config(
            {"id": "x", "slot": 0, "readyRoot": str(wrong_size)}))

    oversized = synthetic_ready_pack(tmp_path / "big", "e" * 64, families=("idle",), audio=False,
                                     extra_bytes=5 * 1024 * 1024)
    with pytest.raises(ValueError, match="exceeds appearance slot 1"):
        factory.build_default_appearance_tree(RUNTIME, out, pets_config(
            {"id": "x", "slot": 1, "readyRoot": str(oversized)}))


def test_local_config_supplies_default_pets_without_touching_the_committed_one(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    committed = {"schemaVersion": 1, "appearanceContract": CONTRACT, "appearances": []}
    (project / "factory-config.json").write_text(json.dumps(committed), encoding="utf-8")
    assert factory.load_factory_config(project, None)["appearances"] == []

    pets = [{"id": "mine", "slot": 0, "readyRoot": "local-defaults/mine"}]
    (project / factory.LOCAL_FACTORY_CONFIG_NAME).write_text(
        json.dumps({"schemaVersion": 1, "appearances": pets}), encoding="utf-8")
    assert factory.load_factory_config(project, None)["appearances"] == pets
    explicit = project / "factory-config.json"
    assert factory.load_factory_config(project, str(explicit))["appearances"] == [], \
        "an explicit config is used exactly as given"
    ignored = (REPOSITORY / ".gitignore").read_text(encoding="utf-8")
    assert "firmware/factory-config.local.json" in ignored and "firmware/local-defaults/" in ignored


def test_factory_components_match_current_builtin_catalog_and_device_files(tmp_path):
    config = json.loads((RUNTIME / "factory-config.json").read_text(encoding="utf-8"))
    expected_ids = [
        "cloud-hop", "stock-watchlist", "wooden-fish", "daily-news",
        "book-pocket", "block-combo", "tomato-clock", "fresh-fruit-slice", "hachimi-sounds",
        "snake-turn", "flappy-bird", "hachimi-learn", "hachimi-home", "hachimi-travel",
        "hachimi-garden", "bloomfrog_companion", "two-key-pong", "hachimi-weather", "daily-almanac",
        "upcoming-todos", "computer-status", "drink-reminder", "hachimi-break", "hachimi-notes", "token-usage",
        "decision-capsule", "answer-book", "hope-train",
    ]
    assert config["components"]["ids"] == expected_ids
    assert len(expected_ids) == 28
    visible = {p.parent.name for p in (REPOSITORY / "pc/builtin-clawpkgs").glob("*/component.json")}
    visible -= {"music-player", "hachimi-agent", "hachimi-desk"}
    assert set(expected_ids) == visible
    assert config["components"]["maxInstalled"] == 32
    assert config["components"]["widgetMaxBytes"] == 8191
    assert "falling-catch" not in config["components"]["ids"]
    assert "slack-off-countdown" not in config["components"]["ids"]
    assert "ten-second-tap" not in config["components"]["ids"]

    spiffs_tree = tmp_path / "factory-spiffs"
    spiffs_tree.mkdir()
    summary = factory.build_builtin_component_tree(RUNTIME, config, spiffs_tree)
    assert summary["count"] == len(expected_ids)
    assert summary["defaultActiveId"] == "cloud-hop"
    assert summary["spriteFiles"] == 76  # All 28 retained packages; no artwork stripped.
    assert summary["payloadBytes"] < 3 * 1024 * 1024
    assert summary["physicalFiles"] == len(expected_ids) * 2 + summary["spriteFiles"] + 1
    assert not (spiffs_tree / "p4-miniapp-id.txt").exists()

    catalog = json.loads(
        (spiffs_tree / "p4-miniapps-0.json").read_text(encoding="utf-8")
    )
    assert catalog["version"] == 3
    assert catalog["sequence"] == 1
    assert catalog["activeWidgetId"] == "cloud-hop"
    assert [item["widgetId"] for item in catalog["items"]] == expected_ids
    assert [item["slot"] for item in catalog["items"]] == list(range(len(expected_ids)))
    assert [item["packageGeneration"] for item in catalog["items"]] == [0] * len(expected_ids)
    assert all(re.fullmatch(r"[0-9a-f]{8}", item["widgetChecksum"]) for item in catalog["items"])
    assert all(re.fullmatch(r"[0-9a-f]{8}", item["buttonsChecksum"]) for item in catalog["items"])
    assert all(re.fullmatch(r"[0-9a-f]{8}", item["spritesChecksum"]) for item in catalog["items"])
    for item in catalog["items"]:
        slot = item["slot"]
        assert item["widgetChecksum"] == (
            f"{factory.fnv1a32_bytes((spiffs_tree / f'p4w{slot:02d}.json').read_bytes()):08x}"
        )
        assert item["buttonsChecksum"] == (
            f"{factory.fnv1a32_bytes((spiffs_tree / f'p4b{slot:02d}.json').read_bytes()):08x}"
        )
    assert all(item["title"] for item in catalog["items"])
    assert all(
        (spiffs_tree / f"p4w{slot:02d}.json").is_file()
        for slot in range(len(expected_ids))
    )
    assert all(
        (spiffs_tree / f"p4b{slot:02d}.json").is_file()
        for slot in range(len(expected_ids))
    )

    stock_widget = json.loads((spiffs_tree / f"p4w{expected_ids.index('stock-watchlist'):02d}.json").read_text(encoding="utf-8"))
    assert stock_widget["data"]["source"] == "stocks.watchlist"
    assert stock_widget["dashboard"]["headline"] == "等待数据"
    assert "hk01810" not in json.dumps(stock_widget)
    two_key_widget = json.loads(
        (spiffs_tree / f"p4w{expected_ids.index('two-key-pong'):02d}.json").read_text(encoding="utf-8")
    )
    two_key_buttons = json.loads(
        (spiffs_tree / f"p4b{expected_ids.index('two-key-pong'):02d}.json").read_text(encoding="utf-8")
    )
    assert two_key_widget["engine"] == "p4-bounded-runtime-v4"
    assert two_key_widget["scene"]["grid"] == {"width": 16, "height": 16}
    assert [binding["action"] for binding in two_key_buttons] == [
        "start",
        "shift_left",
        "shift_right",
        "session.pause",
    ]
    assert [binding["event"] for binding in two_key_buttons] == [
        "button.sw1.short_press",
        "knob.rotate_ccw",
        "knob.rotate_cw",
        "button.sw2.short_press",
    ]

    frog_widget = json.loads(
        (spiffs_tree / f"p4w{expected_ids.index('bloomfrog_companion'):02d}.json").read_text(encoding="utf-8")
    )
    frog_sprite = (spiffs_tree / f"p4s{expected_ids.index('bloomfrog_companion'):02d}-0-0.bin").read_bytes()
    assert frog_widget["dashboard"]["title"] == "蛙蛙养成"
    assert frog_sprite.startswith(b"P4J1")  # Scene art uses the shared full-resolution background.
    assert catalog["items"][expected_ids.index('bloomfrog_companion')]["spritesChecksum"] != "00000000"

    token_widget = json.loads(
        (spiffs_tree / f"p4w{expected_ids.index('token-usage'):02d}.json").read_text(encoding="utf-8")
    )
    assert "readers" not in token_widget
    assert "fetchers" not in token_widget


def test_factory_platformio_targets_and_partition_contract():
    platformio = (RUNTIME / "platformio.ini").read_text(encoding="utf-8")
    integration = (
        RUNTIME / "scripts" / "platformio_factory_image.py"
    ).read_text(encoding="utf-8")
    assert "scripts/platformio_factory_image.py" in platformio
    assert 'name="factory"' in integration
    assert 'name="factory_upload"' in integration
    assert factory.FACTORY_FORMAT == "pet-manager-p4-factory-v1"

    config = json.loads((RUNTIME / "factory-config.json").read_text(encoding="utf-8"))
    offset, size = factory.partition_entry(
        RUNTIME / "partitions.csv", config["spiffs"]["partitionLabel"]
    )
    assert offset == 0x520000
    assert size == 0x6E0000
    slots = [
        factory.partition_entry(RUNTIME / "partitions.csv", factory.APPEARANCE_PARTITION_TEMPLATE.format(slot=slot))
        for slot in range(3)
    ]
    assert slots == [(0xC00000, 0x500000), (0x1100000, 0x500000), (0x1600000, 0x500000)]
    assert slots[-1][0] + slots[-1][1] == 0x1B00000, "the last 5 MiB of flash stays unassigned"
    with pytest.raises(ValueError):
        factory.partition_entry(RUNTIME / "partitions.csv", "appearance3")


def test_factory_esptool_prefers_the_active_platformio_core(tmp_path, monkeypatch):
    core = tmp_path / "pio-core"
    esptool = core / "penv" / "Scripts" / "esptool.exe"
    esptool.parent.mkdir(parents=True)
    esptool.write_bytes(b"launcher")
    monkeypatch.delenv("ESPTOOL", raising=False)
    monkeypatch.delenv("HACHIMO_PLATFORMIO_CORE_DIR", raising=False)
    monkeypatch.setenv("PLATFORMIO_CORE_DIR", str(core))

    assert factory.resolve_esptool(None) == esptool


def test_factory_spiffsgen_prefers_the_active_platformio_core(tmp_path, monkeypatch):
    core = tmp_path / "pio-core"
    spiffsgen = (
        core
        / "packages"
        / "framework-espidf"
        / "components"
        / "spiffs"
        / "spiffsgen.py"
    )
    spiffsgen.parent.mkdir(parents=True)
    spiffsgen.write_text("# factory fixture\n", encoding="utf-8")
    monkeypatch.delenv("SPIFFSGEN", raising=False)
    monkeypatch.delenv("IDF_PATH", raising=False)
    monkeypatch.delenv("HACHIMO_PLATFORMIO_CORE_DIR", raising=False)
    monkeypatch.setenv("PLATFORMIO_CORE_DIR", str(core))

    assert factory.resolve_spiffsgen(None) == spiffsgen
