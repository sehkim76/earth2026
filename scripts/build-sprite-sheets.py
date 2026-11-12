"""병사·무법자 8프레임 PNG(public/markers/*_01~08.png)를 지도용 스프라이트 시트로 합친다.

프레임 하나를 156px(표시 52px × 3배)로 축소해 가로로 8장 붙인다. 캔버스 전체를 축소하므로
프레임 간 위치(정렬)는 원본 그대로다. 원본 프레임을 교체한 뒤 이 스크립트를 다시 실행하면 된다.

    python3 scripts/build-sprite-sheets.py
"""

from pathlib import Path

from PIL import Image

MARKERS = Path(__file__).resolve().parent.parent / "public" / "markers"
FRAME_PX = 156
SETS = ("soldier_idle", "soldier_walk", "outlaw_walk")

for name in SETS:
    sheet = Image.new("RGBA", (FRAME_PX * 8, FRAME_PX), (0, 0, 0, 0))
    for i in range(8):
        frame = Image.open(MARKERS / f"{name}_{i + 1:02d}.png").convert("RGBA")
        sheet.paste(frame.resize((FRAME_PX, FRAME_PX), Image.LANCZOS), (i * FRAME_PX, 0))
    out = MARKERS / f"{name}_sheet.png"
    sheet.save(out, optimize=True)
    print(f"{out.name}: {out.stat().st_size:,} bytes")
