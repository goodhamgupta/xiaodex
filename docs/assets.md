# Visual Assets

Use Codex image generation / Imagen for pet sprites, logo, enclosure mockup,
sticker, splash, and packaging assets.

## Generated Codex Pets

Checked-in generated pet sources include:

- `assets/imagen/codex-spark/sprite-sheet.png`
- `assets/imagen/codex-spark/prompt.txt`
- `assets/imagen/codex-spark/provenance.json`
- `assets/imagen/codex-cat/sprite-sheet.png`
- `assets/imagen/codex-cat/prompt.txt`
- `assets/imagen/codex-cat/provenance.json`
- `assets/imagen/codex-axolotl/sprite-sheet.png`
- `assets/imagen/codex-axolotl/prompt.txt`
- `assets/imagen/codex-axolotl/provenance.json`

Convert the generated sheet into M5StickC Plus GIF assets with:

```bash
python3 firmware/m5stickc-plus/tools/import_imagen_sprite_sheet.py \
  assets/imagen/codex-spark/sprite-sheet.png
```

The importer writes:

- `firmware/m5stickc-plus/characters/codex-spark`
- `firmware/m5stickc-plus/data/characters/codex-spark`

Use `--append-data` when importing additional generated sheets for the same
LittleFS image. The firmware cycles installed packs with **Settings -> sprite
pack**, and `tools/flash_character.py` can stage several prepared packs in one
upload.

The default Codex pet path should only use assets generated through Imagen.

## Stock Characters

`firmware/m5stickc-plus/characters/bufo` is an optional stock character pack.
It is third-party community artwork from bufo.zone, not Imagen-generated, and is
not staged into `firmware/m5stickc-plus/data`.
