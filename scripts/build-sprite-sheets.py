"""병사·무법자 8프레임과 영주(오우거·타락천사) 24프레임 PNG를 지도용 스프라이트 시트로 합친다.

프레임을 표시 크기의 3배(병사·무법자 156px, 영주 198px)로 맞춰 가로로 붙인다. 캔버스 전체를 축소하므로
프레임 간 위치(정렬)는 원본 그대로다. 원본 프레임을 교체한 뒤 이 스크립트를 다시 실행하면 된다.

    python3 scripts/build-sprite-sheets.py
"""

from pathlib import Path

from PIL import Image

PUBLIC = Path(__file__).resolve().parent.parent / "public"
MARKERS = PUBLIC / "markers"

# (원본 프레임 경로 목록, 출력 시트, 프레임 한 변 px)
SHEETS = [
    *[
        ([MARKERS / f"{name}_{i + 1:02d}.png" for i in range(8)], MARKERS / f"{name}_sheet.png", 156)
        for name in ("soldier_idle", "soldier_walk", "outlaw_walk")
    ],
    # 영주 캐릭터 (표시 66px × 3배 = 198px, 24프레임).
    (
        [PUBLIC / "map-assets" / "walking" / f"0_Ogre_Walking_{i:03d}.png" for i in range(24)],
        PUBLIC / "map-assets" / "walking" / "ogre_walk_sheet.png",
        198,
    ),
    (
        [PUBLIC / "map-assets" / "fallen-angel" / f"0_Fallen_Angels_Walking_{i:03d}.png" for i in range(24)],
        PUBLIC / "map-assets" / "fallen-angel" / "fallen_angel_walk_sheet.png",
        198,
    ),
]

for frames, out, frame_px in SHEETS:
    sheet = Image.new("RGBA", (frame_px * len(frames), frame_px), (0, 0, 0, 0))
    for i, path in enumerate(frames):
        frame = Image.open(path).convert("RGBA")
        if frame.size != (frame_px, frame_px):
            frame = frame.resize((frame_px, frame_px), Image.LANCZOS)
        sheet.paste(frame, (i * frame_px, 0))
    sheet.save(out, optimize=True)
    print(f"{out.relative_to(PUBLIC)}: {out.stat().st_size:,} bytes")
