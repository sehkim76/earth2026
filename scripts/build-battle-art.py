"""카드 전투용 픽셀 아트를 코드로 그려 public/battle/ 에 아틀라스 PNG 로 저장한다.

- 카드 그림(병사·전술·장비·토큰) 32×32, 지휘관 초상 32×32, 키워드·능치 아이콘 12×12,
  카드 뒷면·전장 타일(성벽·들판·깃발)을 한 장의 아틀라스로 묶는다.
- 영주(오우거)·보병(병사)·무법자 지휘관은 기존 지도 스프라이트를 축소·감색해 재사용한다.
- 좌표표는 src/components/battle/battle-atlas.ts 로 생성한다 (직접 수정 금지).

모든 그림은 이 게임 세계관(영주·성·부대·무법자, 조선풍 갑옷·갓·깃발)에 맞춰 새로 그린 것이다.

    python3 scripts/build-battle-art.py
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
OUT_DIR = PUBLIC / "battle"
ATLAS_TS = ROOT / "src" / "components" / "battle" / "battle-atlas.ts"
CARDS_TS = ROOT / "src" / "lib" / "battle" / "cards.ts"

RGB = tuple[int, int, int]


def hx(s: str) -> RGB:
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


# 재질: (어두움, 기본, 밝음). flat=True 면 음영 없이 기본색만.
MATERIALS: dict[str, tuple[RGB, RGB, RGB]] = {
    "skin": (hx("9a5a3a"), hx("e3a87c"), hx("f8d3ad")),
    "skin_old": (hx("8a5a44"), hx("d39a78"), hx("ecc2a2")),
    "skin_ogre": (hx("1f5a1f"), hx("3f9a35"), hx("7fcf5a")),
    "steel": (hx("475266"), hx("9aa8ba"), hx("e4ecf4")),
    "dark_steel": (hx("272c3a"), hx("525b70"), hx("8691a8")),
    "gold": (hx("7a5010"), hx("d9a423"), hx("ffe682")),
    "bronze": (hx("5e3714"), hx("a8692c"), hx("e0a25a")),
    "leather": (hx("472a16"), hx("845632"), hx("b8834f")),
    "wood": (hx("45290f"), hx("7d5024"), hx("b27a3c")),
    "red": (hx("5e121c"), hx("b02c38"), hx("ec6d5c")),
    "blue": (hx("1a2b5e"), hx("3a5cae"), hx("7da2e8")),
    "navy": (hx("10183a"), hx("24356e"), hx("4a64a8")),
    "green": (hx("1b4426"), hx("3c7a3a"), hx("80b852")),
    "olive": (hx("323a1a"), hx("5d6a2e"), hx("94a24e")),
    "purple": (hx("341a52"), hx("693c9e"), hx("a77bdc")),
    "white": (hx("8c8a9c"), hx("d6d4e0"), hx("ffffff")),
    "black": (hx("101018"), hx("272736"), hx("474760")),
    "hat_black": (hx("0c0c12"), hx("1e1e2a"), hx("3a3a50")),
    "hair": (hx("17110f"), hx("2e2220"), hx("4d3a33")),
    "beard_white": (hx("9b98a8"), hx("dddbe6"), hx("ffffff")),
    "straw": (hx("8a6420"), hx("d7a947"), hx("f6dc84")),
    "cloth_tan": (hx("6e5638"), hx("b49a6e"), hx("e2cfa2")),
    "horse": (hx("4a2814"), hx("8c5530"), hx("c2834f")),
    "horse_dark": (hx("1e1412"), hx("3d2a24"), hx("68483c")),
    "horse_white": (hx("80808f"), hx("cfd0da"), hx("f6f6fb")),
    "fire": (hx("a8300e"), hx("f27a18"), hx("ffe46a")),
    "magic": (hx("1c3c92"), hx("3f8cff"), hx("bfe8ff")),
    "arcane": (hx("4b1a8a"), hx("9a4dff"), hx("e2c4ff")),
    "lightning": (hx("6b6a12"), hx("f2e94a"), hx("ffffd0")),
    "heal": (hx("1b6a3a"), hx("3fc46a"), hx("bff7b0")),
    "stone": (hx("4b4a52"), hx("85838e"), hx("b9b7c2")),
    "stone_warm": (hx("5a4a3e"), hx("8f7c68"), hx("c4b39b")),
    "grass": (hx("2b4a1c"), hx("4b7a2c"), hx("7fae46")),
    "dirt": (hx("4f3920"), hx("7a5a35"), hx("a68456")),
    "paper": (hx("a08a5a"), hx("e8d9ac"), hx("fff6d6")),
    "rope": (hx("6a4c26"), hx("b08a52"), hx("dcc08a")),
    "crimson_seal": (hx("5a0e12"), hx("b8222a"), hx("f0584e")),
    "jade": (hx("114a3e"), hx("2f9a7c"), hx("8ae0c0")),
    # 평면 재질
    "ink": (hx("150d18"), hx("150d18"), hx("150d18")),
    "eye_white": (hx("ffffff"), hx("ffffff"), hx("ffffff")),
    "blush": (hx("e07a6a"), hx("e07a6a"), hx("e07a6a")),
    "glow": (hx("fff7c0"), hx("fff7c0"), hx("fff7c0")),
    "shadow": (hx("000000"), hx("000000"), hx("000000")),
}
FLAT = {"ink", "eye_white", "blush", "glow", "shadow"}
OUTLINE = hx("1a1020")


class Sprite:
    def __init__(self, w: int, h: int) -> None:
        self.w = w
        self.h = h
        self.grid: list[list[str | None]] = [[None] * w for _ in range(h)]
        # 재질 대신 직접 색을 지정한 픽셀 (음영 제외)
        self.raw: dict[tuple[int, int], tuple[int, int, int, int]] = {}

    def px(self, x: int, y: int, m: str | None) -> None:
        if 0 <= x < self.w and 0 <= y < self.h:
            self.grid[y][x] = m
            self.raw.pop((x, y), None)

    def color(self, x: int, y: int, rgba: tuple[int, int, int, int]) -> None:
        if 0 <= x < self.w and 0 <= y < self.h:
            self.grid[y][x] = "__raw"
            self.raw[(x, y)] = rgba

    def get(self, x: int, y: int) -> str | None:
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.grid[y][x]
        return None

    def rect(self, x0: int, y0: int, x1: int, y1: int, m: str | None) -> None:
        for y in range(min(y0, y1), max(y0, y1) + 1):
            for x in range(min(x0, x1), max(x0, x1) + 1):
                self.px(x, y, m)

    def ellipse(self, cx: float, cy: float, rx: float, ry: float, m: str | None) -> None:
        for y in range(int(cy - ry - 1), int(cy + ry + 2)):
            for x in range(int(cx - rx - 1), int(cx + rx + 2)):
                dx = (x + 0.5 - cx) / max(rx, 0.01)
                dy = (y + 0.5 - cy) / max(ry, 0.01)
                if dx * dx + dy * dy <= 1.0:
                    self.px(x, y, m)

    def line(self, x0: int, y0: int, x1: int, y1: int, m: str | None, width: int = 1) -> None:
        dx = abs(x1 - x0)
        dy = -abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx + dy
        x, y = x0, y0
        while True:
            for ox in range(width):
                for oy in range(width):
                    self.px(x + ox, y + oy, m)
            if x == x1 and y == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x += sx
            if e2 <= dx:
                err += dx
                y += sy

    def poly(self, pts: list[tuple[float, float]], m: str | None) -> None:
        ys = [p[1] for p in pts]
        for y in range(int(min(ys)), int(max(ys)) + 1):
            yc = y + 0.5
            xs: list[float] = []
            n = len(pts)
            for i in range(n):
                ax, ay = pts[i]
                bx, by = pts[(i + 1) % n]
                if (ay <= yc < by) or (by <= yc < ay):
                    xs.append(ax + (yc - ay) * (bx - ax) / (by - ay))
            xs.sort()
            for i in range(0, len(xs) - 1, 2):
                for x in range(int(math.ceil(xs[i] - 0.5)), int(math.floor(xs[i + 1] - 0.5)) + 1):
                    self.px(x, y, m)

    def render(self, outline: bool = True, white_rim: bool = False) -> Image.Image:
        img = np.zeros((self.h, self.w, 4), dtype=np.uint8)
        for y in range(self.h):
            for x in range(self.w):
                m = self.grid[y][x]
                if m is None:
                    continue
                if m == "__raw":
                    img[y, x] = self.raw[(x, y)]
                    continue
                dark, mid, light = MATERIALS[m]
                c = mid
                if m not in FLAT:
                    up = self.get(x, y - 1) != m
                    left = self.get(x - 1, y) != m
                    down = self.get(x, y + 1) != m
                    right = self.get(x + 1, y) != m
                    if (down or right) and not (up and left):
                        c = dark
                    elif (up or left) and not (down and right):
                        c = light
                img[y, x] = (*c, 255)
        if outline:
            alpha = img[:, :, 3] > 0
            out = img.copy()
            for y in range(self.h):
                for x in range(self.w):
                    if alpha[y, x]:
                        continue
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < self.w and 0 <= ny < self.h and alpha[ny, nx]:
                            out[y, x] = (*OUTLINE, 255)
                            break
            img = out
        if white_rim:
            alpha = img[:, :, 3] > 0
            out = img.copy()
            for y in range(self.h):
                for x in range(self.w):
                    if alpha[y, x]:
                        continue
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < self.w and 0 <= ny < self.h and alpha[ny, nx]:
                            out[y, x] = (250, 244, 228, 255)
                            break
            img = out
        return Image.fromarray(img, "RGBA")


# ---------------------------------------------------------------------------
# 꼬마 병사 (오른쪽을 보는 3/4 시점, 큰 머리)
# ---------------------------------------------------------------------------


def chibi(sp: Sprite, spec: dict[str, object], ox: int = 0, oy: int = 0) -> None:
    g = spec.get
    skin = str(g("skin", "skin"))
    body = str(g("body", "leather"))
    trim = g("trim")
    legs = str(g("legs", "black"))
    boots = str(g("boots", "leather"))
    mounted = bool(g("mounted", False))

    def P(x: int, y: int) -> tuple[int, int]:
        return x + ox, y + oy

    # 망토 (몸 뒤)
    cape = g("cape")
    if cape:
        sp.poly([P(10, 17), P(15, 17), P(13, 28), P(6, 29)] if not mounted else [P(10, 17), P(15, 17), P(12, 24), P(4, 25)], str(cape))

    # 뒤쪽 무기 (등 뒤 화살통 등)
    if g("quiver"):
        sp.rect(*P(8, 14), *P(10, 22), "leather")
        sp.rect(*P(8, 12), *P(8, 13), "white")
        sp.rect(*P(10, 11), *P(10, 13), "white")

    if not mounted:
        # 다리·신발
        sp.rect(*P(12, 25), *P(14, 27), legs)
        sp.rect(*P(17, 25), *P(19, 27), legs)
        sp.rect(*P(11, 28), *P(14, 29), boots)
        sp.rect(*P(17, 28), *P(20, 29), boots)

    # 뒤팔
    sp.rect(*P(9, 19), *P(10, 23), body)
    sp.rect(*P(9, 24), *P(10, 24), skin)

    # 몸통
    robe = bool(g("robe", False))
    if robe:
        sp.poly([P(11, 18), P(20, 18), P(22, 29), P(9, 29)], body)
        if not mounted:
            sp.rect(*P(11, 28), *P(13, 29), boots)
            sp.rect(*P(18, 28), *P(20, 29), boots)
    else:
        sp.rect(*P(11, 18), *P(20, 25), body)
        sp.rect(*P(11, 24), *P(20, 24), str(g("belt", "leather")))
    if trim:
        sp.rect(*P(15, 18), *P(16, 23), str(trim))
    if g("pauldron"):
        sp.ellipse(*P(19, 19), 2.6, 2, str(g("pauldron")))
        sp.ellipse(*P(11, 19), 2, 1.8, str(g("pauldron")))
    if g("emblem"):
        sp.rect(*P(13, 20), *P(14, 21), str(g("emblem")))

    # 머리
    head_cy = 11
    sp.ellipse(*P(16, head_cy), 6.6, 6.2, skin)
    # 머리카락 (뒤통수)
    hair = str(g("hair", "hair"))
    sp.ellipse(*P(13, 10), 4.2, 4.2, hair)
    # 얼굴 (오른쪽)
    sp.ellipse(*P(17.5, 12), 4.6, 4.6, skin)
    # 눈 (오른쪽을 본다)
    eye_y = 12
    sp.rect(*P(17, eye_y), *P(17, eye_y + 1), "ink")
    sp.rect(*P(20, eye_y), *P(20, eye_y + 1), "ink")
    if g("angry"):
        sp.px(*P(16, eye_y - 1), "ink")
        sp.px(*P(21, eye_y - 1), "ink")
    if g("blush", True):
        sp.px(*P(21, eye_y + 2), "blush")
    if g("beard"):
        sp.poly([P(14, 14), P(22, 14), P(20, 19), P(16, 19)], str(g("beard")))
        sp.rect(*P(18, 15), *P(19, 15), "ink")
    elif g("mask"):
        sp.poly([P(14, 13.5), P(23, 13.5), P(22, 17), P(15, 17)], str(g("mask")))
    else:
        sp.px(*P(19, 15), "ink")
    if g("scar"):
        sp.line(*P(20, 10), *P(21, 13), "red")

    # 투구·모자
    helm = g("helm")
    hm = str(g("helm_mat", "steel"))
    if helm == "conical":  # 조선풍 투구: 둥근 몸체 + 첨정 + 드림
        sp.ellipse(*P(16, 8), 7, 4.6, hm)
        sp.rect(*P(9, 8), *P(23, 9), hm)
        sp.rect(*P(9, 9), *P(23, 9), str(g("helm_band", "gold")))
        sp.line(*P(16, 1), *P(16, 4), str(g("helm_band", "gold")), 1)
        sp.px(*P(16, 0), str(g("plume", "red")))
        sp.rect(*P(15, 0), *P(17, 1), str(g("plume", "red")))
        # 목 드림 (뒤)
        sp.rect(*P(9, 10), *P(11, 15), str(g("drape", "red")))
    elif helm == "crested":  # 볏 투구
        sp.ellipse(*P(16, 8), 7, 4.8, hm)
        sp.rect(*P(9, 9), *P(23, 9), hm)
        sp.poly([P(10, 3), P(20, 1), P(22, 4), P(12, 6)], str(g("plume", "red")))
        sp.rect(*P(21, 9), *P(22, 13), hm)  # 볼가리개
    elif helm == "kettle":  # 챙 넓은 투구
        sp.ellipse(*P(16, 7.5), 6, 4.2, hm)
        sp.rect(*P(7, 9), *P(25, 10), hm)
    elif helm == "cap":  # 천 두건
        sp.ellipse(*P(15.5, 7.5), 6.6, 4.2, hm)
        sp.rect(*P(9, 8), *P(22, 9), str(g("helm_band", "red")))
        sp.line(*P(9, 9), *P(6, 13), str(g("helm_band", "red")))
    elif helm == "headband":
        sp.rect(*P(10, 7), *P(22, 8), str(g("helm_band", "red")))
        sp.line(*P(10, 8), *P(6, 11), str(g("helm_band", "red")))
        sp.line(*P(10, 7), *P(5, 8), str(g("helm_band", "red")))
    elif helm == "gat":  # 갓 (넓은 챙 검은 모자)
        sp.rect(*P(13, 2), *P(19, 7), "hat_black")
        sp.ellipse(*P(16, 7.8), 10, 1.6, "hat_black")
        sp.line(*P(21, 9), *P(21, 18), "ink")  # 갓끈
    elif helm == "hood":
        sp.poly([P(8, 13), P(10, 5), P(16, 3), P(22, 5), P(24, 10), P(22, 9), P(14, 9), P(12, 16)], hm)
        sp.poly([P(8, 13), P(5, 17), P(10, 15)], hm)
    elif helm == "wizard":
        sp.poly([P(8, 9), P(24, 9), P(18, 4), P(21, -1), P(13, 3)], hm)
        sp.rect(*P(8, 8), *P(24, 9), str(g("helm_band", "gold")))
    elif helm == "crown":  # 근위 금투구
        sp.ellipse(*P(16, 8), 7, 4.8, hm)
        sp.rect(*P(9, 9), *P(23, 9), hm)
        sp.poly([P(11, 5), P(13, 1), P(15, 4), P(17, 0), P(19, 4), P(21, 1), P(22, 5)], "gold")
        sp.rect(*P(15, 6), *P(17, 7), "jade")
        sp.rect(*P(21, 9), *P(22, 13), hm)
    elif helm == "straw":  # 삿갓
        sp.poly([P(5, 9), P(16, 2), P(27, 9)], "straw")
        sp.rect(*P(6, 9), *P(26, 9), "straw")
    elif helm == "bandana":
        sp.ellipse(*P(15.5, 7.5), 6.6, 4.0, hm)
        sp.poly([P(9, 8), P(5, 10), P(7, 12), P(10, 10)], hm)

    # 앞 방패
    shield = g("shield")
    if shield == "round":
        sm = str(g("shield_mat", "wood"))
        sp.ellipse(*P(11, 21.5), 5, 5.5, sm)
        sp.ellipse(*P(11, 21.5), 2.2, 2.4, str(g("shield_rim", "steel")))
        sp.ellipse(*P(11, 21.5), 1, 1, "gold")
    elif shield == "tower":
        sm = str(g("shield_mat", "red"))
        sp.poly([P(6, 15), P(15, 15), P(15, 25), P(10.5, 29), P(6, 25)], sm)
        sp.rect(*P(6, 15), *P(15, 16), str(g("shield_rim", "gold")))
        sp.ellipse(*P(10.5, 21.5), 2.2, 2.2, str(g("shield_rim", "gold")))
        sp.px(*P(10, 21), "ink")
    elif shield == "kite":
        sm = str(g("shield_mat", "blue"))
        sp.poly([P(6, 16), P(15, 16), P(15, 23), P(10.5, 29), P(6, 23)], sm)
        sp.ellipse(*P(10.5, 20.5), 2, 2, str(g("shield_rim", "gold")))

    # 앞팔 + 손
    sp.rect(*P(20, 19), *P(22, 22), body if not g("arm") else str(g("arm")))
    sp.rect(*P(21, 23), *P(22, 24), skin)

    # 무기
    weapon = g("weapon")
    if weapon == "spear":
        sp.line(*P(24, 3), *P(22, 30), "wood")
        sp.poly([P(23.5, -0.5), P(26, 4), P(23, 5)], "steel")
        if g("tassel"):
            sp.rect(*P(23, 5), *P(25, 6), "red")
    elif weapon == "halberd":
        sp.line(*P(25, 2), *P(23, 30), "wood")
        sp.poly([P(25, 0), P(27, 4), P(25, 5)], "steel")
        sp.poly([P(26, 4), P(30, 3), P(30, 8), P(26, 7)], "steel")
    elif weapon == "sword":
        sp.line(*P(22, 22), *P(28, 10), "steel", 2)
        sp.rect(*P(20, 22), *P(24, 22), "gold")
    elif weapon == "dagger":
        sp.line(*P(23, 22), *P(27, 17), "steel", 1)
        sp.line(*P(24, 22), *P(28, 17), "steel", 1)
        sp.rect(*P(22, 23), *P(23, 23), "gold")
    elif weapon == "bow":
        for t in range(0, 19):
            a = -1.15 + t * (2.3 / 18)
            x = int(round(23 + 4.2 * math.cos(a)))
            y = int(round(21 + 9.5 * math.sin(a)))
            sp.px(*P(x, y), "wood")
        sp.line(*P(24, 12), *P(24, 30), "white")
    elif weapon == "longbow":
        for t in range(0, 25):
            a = -1.2 + t * (2.4 / 24)
            x = int(round(22 + 5 * math.cos(a)))
            y = int(round(18 + 13 * math.sin(a)))
            sp.px(*P(x, y), "wood")
        sp.line(*P(24, 5), *P(24, 31), "white")
        sp.line(*P(17, 18), *P(29, 18), "wood")
        sp.poly([P(29, 16), P(31, 18), P(29, 20)], "steel")
    elif weapon == "staff":
        sp.line(*P(24, 6), *P(23, 30), "wood")
        orb = str(g("orb", "magic"))
        sp.ellipse(*P(24.5, 4.5), 2.6, 2.6, orb)
        sp.px(*P(24, 3), "glow")
    elif weapon == "torch":
        sp.line(*P(24, 12), *P(22, 24), "wood")
        sp.ellipse(*P(24.5, 9), 2.6, 3.4, "fire")
        sp.px(*P(24, 9), "glow")
        sp.px(*P(25, 6), "fire")
    elif weapon == "pitchfork":
        sp.line(*P(24, 6), *P(22, 30), "wood")
        sp.rect(*P(22, 5), *P(27, 5), "steel")
        for x in (22, 24, 27):
            sp.rect(*P(x, 1), *P(x, 4), "steel")
    elif weapon == "lance":
        sp.poly([P(20, 21), P(31, 3), P(32, 4), P(22, 23)], "steel")
        sp.rect(*P(19, 21), *P(22, 23), "gold")
        sp.poly([P(27, 8), P(30, 7), P(29, 11)], "red")
    elif weapon == "scroll":
        sp.rect(*P(21, 20), *P(26, 25), "paper")
        sp.rect(*P(21, 20), *P(21, 25), "wood")
        sp.rect(*P(26, 20), *P(26, 25), "wood")
        sp.line(*P(22, 22), *P(25, 22), "ink")
    elif weapon == "axe":
        sp.line(*P(24, 8), *P(22, 26), "wood")
        sp.poly([P(24, 7), P(29, 5), P(29, 12), P(24, 11)], "steel")


def horse(sp: Sprite, mat: str, barding: str | None = None, oy: int = 0) -> None:
    # 몸통 (오른쪽을 본다)
    sp.ellipse(15, 22 + oy, 9.5, 4.6, mat)
    # 다리
    for x, dx in ((8, -1), (11, 0), (19, 1), (22, 1)):
        sp.line(x, 25 + oy, x + dx, 30 + oy, mat, 2)
        sp.rect(x + dx, 30 + oy, x + dx + 1, 31 + oy, "ink")
    # 목·머리
    sp.poly([(20, 21 + oy), (24, 12 + oy), (28, 12 + oy), (26, 22 + oy)], mat)
    sp.poly([(24, 11 + oy), (31, 15 + oy), (30, 18 + oy), (25, 16 + oy)], mat)
    sp.px(27, 13 + oy, "ink")
    sp.px(24, 10 + oy, mat)
    # 갈기
    mane = "hair" if mat != "horse_dark" else "black"
    sp.line(23, 12 + oy, 20, 19 + oy, mane, 2)
    # 꼬리
    sp.line(6, 19 + oy, 2, 27 + oy, mane, 2)
    if barding:
        sp.poly([(9, 19 + oy), (21, 19 + oy), (22, 26 + oy), (8, 26 + oy)], barding)
        sp.rect(9, 25 + oy, 22, 25 + oy, "gold")


# ---------------------------------------------------------------------------
# 카드 그림
# ---------------------------------------------------------------------------


def art_soldier(spec: dict[str, object]) -> Callable[[], Image.Image]:
    def draw() -> Image.Image:
        sp = Sprite(32, 32)
        chibi(sp, spec, 0, 1)
        return sp.render()

    return draw


def art_rider(spec: dict[str, object], horse_mat: str, barding: str | None) -> Callable[[], Image.Image]:
    def draw() -> Image.Image:
        sp = Sprite(32, 32)
        horse(sp, horse_mat, barding, 0)
        spec2 = dict(spec)
        spec2["mounted"] = True
        chibi(sp, spec2, -3, -6)
        # 말 머리가 위에 보이도록 다시 그린다
        sp.poly([(24, 11), (31, 15), (30, 18), (25, 16)], horse_mat)
        sp.px(27, 13, "ink")
        return sp.render()

    return draw


def art_field_medic() -> Image.Image:
    sp = Sprite(32, 32)
    # 약초 바구니 + 붕대 두루마리 + 약초 잎
    sp.ellipse(16, 23, 11, 5, "straw")
    sp.rect(6, 17, 26, 23, "straw")
    for x in range(7, 26, 3):
        sp.line(x, 18, x, 26, "wood")
    sp.ellipse(16, 17, 10, 2.4, "wood")
    sp.ellipse(11, 14, 4, 3, "white")
    sp.rect(11, 11, 22, 16, "white")
    sp.ellipse(22, 13.5, 3, 3, "white")
    sp.line(12, 13, 21, 13, "red")
    for (x, y) in ((22, 6), (8, 8), (26, 10)):
        sp.ellipse(x, y, 2.5, 3.5, "heal")
        sp.line(x, y - 3, x, y + 3, "green")
    for (x, y) in ((4, 4), (28, 3), (16, 4)):
        sp.rect(x, y - 1, x, y + 1, "heal")
        sp.rect(x - 1, y, x + 1, y, "heal")
    return sp.render()


def art_war_council() -> Image.Image:
    sp = Sprite(32, 32)
    # 군막(천막) + 작전 지도 탁자
    sp.poly([(2, 18), (16, 3), (30, 18)], "red")
    sp.poly([(13, 18), (16, 8), (19, 18)], "black")
    sp.line(16, 0, 16, 4, "wood")
    sp.poly([(16, 0), (21, 1), (16, 3)], "gold")
    sp.rect(3, 17, 29, 18, "gold")
    sp.rect(4, 22, 28, 25, "wood")
    sp.rect(6, 26, 7, 30, "wood")
    sp.rect(25, 26, 26, 30, "wood")
    sp.rect(7, 20, 25, 22, "paper")
    sp.line(9, 21, 14, 20, "red")
    sp.px(18, 21, "blue")
    sp.px(21, 20, "blue")
    sp.px(12, 20, "red")
    return sp.render()


def art_pike_wall() -> Image.Image:
    sp = Sprite(32, 32)
    # 장창 방진: 비스듬히 선 창 여러 자루 + 방패 열
    for i, x in enumerate((3, 9, 15, 21, 27)):
        sp.line(x - 2, 30, x + 4, 2 + (i % 2) * 2, "wood")
        sp.poly([(x + 3.5, -0.5 + (i % 2) * 2), (x + 6, 3 + (i % 2) * 2), (x + 3, 5 + (i % 2) * 2)], "steel")
    for x in (1, 9, 17, 25):
        sp.rect(x, 18, x + 6, 28, "red")
        sp.rect(x + 2, 20, x + 4, 26, "gold")
    return sp.render()


def art_fire_arrow() -> Image.Image:
    sp = Sprite(32, 32)
    sp.line(3, 29, 24, 8, "wood", 1)
    sp.line(4, 29, 25, 8, "wood", 1)
    sp.poly([(23, 6), (29, 3), (26, 9)], "steel")
    for (x, y) in ((3, 29), (5, 27)):
        sp.poly([(x - 2, y - 2), (x, y), (x - 3, y + 1)], "white")
    sp.ellipse(22, 10, 5, 4, "fire")
    sp.ellipse(18, 14, 4, 3, "fire")
    sp.ellipse(14, 18, 3, 2.4, "fire")
    sp.ellipse(22, 9, 2, 1.6, "glow")
    for (x, y) in ((10, 22), (8, 20), (12, 25)):
        sp.px(x, y, "fire")
    return sp.render()


def art_arrow_storm() -> Image.Image:
    sp = Sprite(32, 32)
    for (x, y) in ((4, 2), (13, 0), (22, 3), (8, 13), (18, 11), (27, 12), (3, 22), (14, 21), (24, 22)):
        sp.line(x, y, x + 4, y + 8, "wood")
        sp.poly([(x + 3, y + 8), (x + 6, y + 8), (x + 5.5, y + 11)], "steel")
        sp.px(x, y, "white")
        sp.px(x - 1, y, "white")
    sp.rect(0, 31, 31, 31, "dirt")
    return sp.render()


def art_spur_on() -> Image.Image:
    sp = Sprite(32, 32)
    # 박차 달린 장화 + 속도선
    sp.rect(13, 3, 21, 20, "leather")
    sp.poly([(13, 20), (21, 20), (28, 24), (28, 28), (11, 28), (11, 22)], "leather")
    sp.rect(11, 27, 28, 28, "black")
    sp.rect(13, 3, 21, 5, "bronze")
    sp.line(8, 22, 12, 22, "gold")
    sp.ellipse(6, 22, 2.6, 2.6, "gold")
    sp.px(6, 22, "ink")
    for (y, x0, x1) in ((8, 1, 9), (13, 0, 10), (18, 2, 8)):
        sp.line(x0, y, x1, y, "white")
    return sp.render()


def art_mana_bolt() -> Image.Image:
    sp = Sprite(32, 32)
    sp.poly([(1, 31), (15, 10), (24, 19)], "magic")
    sp.poly([(6, 27), (16, 13), (20, 17)], "arcane")
    sp.ellipse(20, 12, 7, 7, "magic")
    sp.ellipse(20.5, 11.5, 4, 4, "glow")
    for (x, y) in ((4, 22), (9, 28), (2, 26)):
        sp.px(x, y, "glow")
    for (x, y) in ((28, 3), (30, 18), (12, 6), (26, 24)):
        sp.rect(x, y - 1, x, y + 1, "magic")
        sp.rect(x - 1, y, x + 1, y, "magic")
    return sp.render()


def art_thunder_net() -> Image.Image:
    sp = Sprite(32, 32)
    # 번개 그물
    pts = [(2, 4), (9, 2), (16, 5), (23, 2), (30, 6)]
    for (x, y) in pts:
        sp.line(x, y, 16, 26, "lightning")
    sp.line(2, 4, 30, 6, "lightning")
    sp.line(5, 13, 27, 14, "lightning")
    sp.line(10, 20, 22, 21, "lightning")
    sp.poly([(14, 0), (19, 0), (16, 9), (21, 9), (12, 22), (14, 12), (10, 12)], "lightning")
    sp.ellipse(16, 27, 6, 3, "magic")
    return sp.render()


def art_spare_mana() -> Image.Image:
    sp = Sprite(32, 32)
    # 엽전 모양 마나 구슬 (가운데 네모 구멍)
    sp.ellipse(16, 16, 11, 11, "magic")
    sp.ellipse(16, 16, 8, 8, "blue")
    sp.rect(14, 14, 18, 18, None)
    sp.rect(13, 13, 19, 13, "glow")
    sp.px(10, 10, "glow")
    sp.px(11, 9, "glow")
    return sp.render()


def art_battle_axe() -> Image.Image:
    sp = Sprite(32, 32)
    sp.line(7, 30, 22, 5, "wood", 2)
    sp.poly([(17, 4), (27, 0), (31, 9), (27, 17), (19, 12)], "steel")
    sp.poly([(21, 6), (27, 3), (29, 9), (26, 14), (22, 10)], "dark_steel")
    sp.rect(18, 9, 21, 11, "bronze")
    sp.rect(6, 29, 8, 31, "bronze")
    return sp.render()


def art_cavalry_lance() -> Image.Image:
    sp = Sprite(32, 32)
    sp.poly([(1, 30), (26, 3), (29, 6), (4, 31)], "steel")
    sp.poly([(26, 3), (31, 0), (29, 6)], "dark_steel")
    sp.poly([(2, 26), (9, 20), (12, 23), (6, 30)], "gold")
    sp.poly([(16, 12), (24, 11), (21, 18)], "red")
    sp.poly([(16, 12), (21, 18), (15, 19)], "white")
    return sp.render()


CARD_ARTS: dict[str, Callable[[], Image.Image]] = {
    "soldier-recruit-spear": art_soldier(
        {"helm": "kettle", "helm_mat": "bronze", "body": "cloth_tan", "belt": "leather", "weapon": "spear", "legs": "leather"}
    ),
    "soldier-beacon-runner": art_soldier(
        {"helm": "headband", "helm_band": "red", "body": "olive", "weapon": "torch", "legs": "cloth_tan", "boots": "straw"}
    ),
    "soldier-conscriptor": art_soldier(
        {"helm": "gat", "body": "navy", "robe": True, "trim": "white", "weapon": "scroll", "boots": "black"}
    ),
    "soldier-fort-captain": art_soldier(
        {
            "helm": "conical",
            "helm_mat": "dark_steel",
            "plume": "red",
            "drape": "red",
            "body": "red",
            "trim": "gold",
            "pauldron": "dark_steel",
            "shield": "tower",
            "shield_mat": "stone_warm",
            "shield_rim": "dark_steel",
            "weapon": "spear",
            "tassel": True,
            "angry": True,
        }
    ),
    "soldier-veteran-centurion": art_soldier(
        {
            "helm": "crested",
            "helm_mat": "steel",
            "plume": "red",
            "body": "dark_steel",
            "trim": "red",
            "cape": "red",
            "pauldron": "steel",
            "weapon": "sword",
            "scar": True,
            "angry": True,
        }
    ),
    "soldier-royal-guardian": art_soldier(
        {
            "helm": "crown",
            "helm_mat": "gold",
            "body": "white",
            "trim": "gold",
            "cape": "blue",
            "pauldron": "gold",
            "shield": "kite",
            "shield_mat": "blue",
            "shield_rim": "gold",
            "weapon": "spear",
            "tassel": True,
        }
    ),
    "soldier-shield-bearer": art_soldier(
        {"helm": "conical", "helm_mat": "steel", "plume": "blue", "drape": "blue", "body": "blue", "shield": "round", "shield_mat": "wood", "weapon": "spear"}
    ),
    "soldier-old-veteran": art_soldier(
        {
            "helm": "conical",
            "helm_mat": "bronze",
            "plume": "white",
            "drape": "leather",
            "skin": "skin_old",
            "beard": "beard_white",
            "body": "bronze",
            "pauldron": "bronze",
            "weapon": "halberd",
            "angry": True,
            "blush": False,
        }
    ),
    "soldier-novice-archer": art_soldier(
        {"helm": "cap", "helm_mat": "green", "helm_band": "cloth_tan", "body": "green", "weapon": "bow", "legs": "cloth_tan", "quiver": True}
    ),
    "soldier-marksman": art_soldier(
        {"helm": "hood", "helm_mat": "olive", "body": "olive", "belt": "leather", "weapon": "longbow", "quiver": True, "angry": True, "blush": False}
    ),
    "soldier-scout-rider": art_rider(
        {"helm": "headband", "helm_band": "blue", "body": "cloth_tan", "weapon": "sword"}, "horse", None
    ),
    "soldier-charge-knight": art_rider(
        {"helm": "crested", "helm_mat": "steel", "plume": "gold", "body": "dark_steel", "weapon": "lance", "angry": True},
        "horse_dark",
        "red",
    ),
    "soldier-ward-weaver": art_soldier(
        {"helm": "hood", "helm_mat": "purple", "body": "purple", "robe": True, "trim": "gold", "weapon": "staff", "orb": "arcane"}
    ),
    "soldier-elder-sorcerer": art_soldier(
        {"helm": "wizard", "helm_mat": "navy", "helm_band": "gold", "beard": "beard_white", "skin": "skin_old", "body": "navy", "robe": True, "trim": "gold", "weapon": "staff", "orb": "magic", "blush": False}
    ),
    "soldier-militia": art_soldier(
        {"helm": "straw", "body": "cloth_tan", "weapon": "pitchfork", "legs": "cloth_tan", "boots": "straw"}
    ),
    "soldier-outlaw-thug": art_soldier(
        {"helm": "bandana", "helm_mat": "leather", "mask": "red", "body": "leather", "belt": "black", "weapon": "dagger", "angry": True, "blush": False}
    ),
    "tactic-field-medic": art_field_medic,
    "tactic-war-council": art_war_council,
    "tactic-pike-wall": art_pike_wall,
    "tactic-fire-arrow": art_fire_arrow,
    "tactic-arrow-storm": art_arrow_storm,
    "tactic-spur-on": art_spur_on,
    "tactic-mana-bolt": art_mana_bolt,
    "tactic-thunder-net": art_thunder_net,
    "tactic-spare-mana": art_spare_mana,
    "equip-battle-axe": art_battle_axe,
    "equip-cavalry-lance": art_cavalry_lance,
}

# ---------------------------------------------------------------------------
# 지휘관 초상
# ---------------------------------------------------------------------------


def strip_sticker_rim(img: Image.Image) -> Image.Image:
    """스티커식 흰 테두리를 바깥에서부터 지운다 (외곽과 이어진 흰 픽셀만)."""
    arr = np.array(img)
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3].astype(int)
    passable = (arr[:, :, 3] < 250) | ((rgb.min(axis=2) > 150) & (rgb.max(axis=2) - rgb.min(axis=2) < 40))
    seen = np.zeros((h, w), dtype=bool)
    stack = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y, x] or not passable[y, x]:
            continue
        seen[y, x] = True
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    arr[seen, 3] = 0
    return Image.fromarray(arr, "RGBA")


def from_sprite(path: Path, size: int, crop: tuple[float, float, float, float] | None = None, colors: int = 28) -> Image.Image:
    """기존 일러스트 스프라이트를 픽셀 아트로 축소 (감색 + 이진 알파 + 외곽선)."""
    src = Image.open(path).convert("RGBA")
    src = strip_sticker_rim(src)
    bbox = src.getbbox()
    if bbox:
        src = src.crop(bbox)
    if crop:
        w, h = src.size
        src = src.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
    w, h = src.size
    side = max(w, h)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(src, ((side - w) // 2, side - h))
    inner = size - 2
    small = sq.resize((inner, inner), Image.Resampling.LANCZOS)
    arr = np.array(small)
    alpha = arr[:, :, 3]
    rgb = Image.fromarray(arr[:, :, :3], "RGB").quantize(colors=colors, method=Image.Quantize.MEDIANCUT).convert("RGB")
    rgba = np.dstack([np.array(rgb), np.where(alpha > 110, 255, 0).astype(np.uint8)])
    out = np.zeros((size, size, 4), dtype=np.uint8)
    out[1 : size - 1, 1 : size - 1] = rgba
    a = out[:, :, 3] > 0
    res = out.copy()
    for y in range(size):
        for x in range(size):
            if a[y, x]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < size and 0 <= ny < size and a[ny, nx]:
                    res[y, x] = (*OUTLINE, 255)
                    break
    return Image.fromarray(res, "RGBA")


def commander_proc(spec: dict[str, object], banner: str | None = None, rider: str | None = None) -> Callable[[], Image.Image]:
    def draw() -> Image.Image:
        sp = Sprite(32, 32)
        if banner:
            sp.line(4, 1, 4, 30, "wood")
            sp.poly([(5, 2), (12, 2), (12, 12), (8.5, 10), (5, 12)], banner)
            sp.rect(7, 5, 10, 7, "gold")
        if rider:
            horse(sp, rider, "blue", 0)
            s2 = dict(spec)
            s2["mounted"] = True
            chibi(sp, s2, -3, -6)
            sp.poly([(24, 11), (31, 15), (30, 18), (25, 16)], rider)
            sp.px(27, 13, "ink")
        else:
            chibi(sp, spec, 0, 1)
        return sp.render()

    return draw


COMMANDER_ARTS: dict[str, Callable[[], Image.Image]] = {
    "cmd-lord": lambda: from_sprite(PUBLIC / "map-assets" / "walking" / "0_Ogre_Walking_000.png", 32, (0.0, 0.0, 1.0, 0.86)),
    "cmd-infantry": lambda: from_sprite(PUBLIC / "markers" / "soldier_idle_01.png", 32),
    "cmd-outlaw": lambda: from_sprite(PUBLIC / "markers" / "outlaw_walk_01.png", 32),
    "cmd-archer": commander_proc(
        {"helm": "conical", "helm_mat": "green", "plume": "gold", "drape": "green", "body": "green", "trim": "gold", "weapon": "longbow", "quiver": True, "cape": "olive", "angry": True},
        banner=None,
    ),
    "cmd-cavalry": commander_proc(
        {"helm": "crested", "helm_mat": "gold", "plume": "red", "body": "red", "weapon": "lance", "angry": True},
        rider="horse_white",
    ),
    "cmd-mage": commander_proc(
        {"helm": "wizard", "helm_mat": "purple", "helm_band": "gold", "body": "purple", "robe": True, "trim": "gold", "weapon": "staff", "orb": "arcane", "cape": "navy"},
    ),
    "cmd-garrison": commander_proc(
        {
            "helm": "conical",
            "helm_mat": "dark_steel",
            "plume": "white",
            "drape": "navy",
            "body": "stone",
            "pauldron": "dark_steel",
            "shield": "tower",
            "shield_mat": "navy",
            "shield_rim": "steel",
            "weapon": "spear",
            "angry": True,
        },
        banner="navy",
    ),
}

# ---------------------------------------------------------------------------
# 아이콘 12×12
# ---------------------------------------------------------------------------


def icon(fn: Callable[[Sprite], None]) -> Callable[[], Image.Image]:
    def draw() -> Image.Image:
        sp = Sprite(12, 12)
        fn(sp)
        return sp.render()

    return draw


def ic_guard(sp: Sprite) -> None:  # 수호: 성가퀴 모양 방패
    sp.poly([(1, 2), (10, 2), (10, 7), (5.5, 11), (1, 7)], "stone")
    for x in (1, 4, 7, 10):
        sp.px(x, 1, "stone")
    sp.rect(5, 4, 6, 7, "ink")


def ic_rush(sp: Sprite) -> None:  # 기습: 번개 말발굽
    sp.poly([(6, 0), (10, 0), (7, 5), (10, 5), (3, 11), (5, 6), (2, 6)], "lightning")


def ic_shield(sp: Sprite) -> None:  # 결계: 육각 빛 막
    sp.poly([(6, 0), (11, 3), (11, 8), (6, 11), (1, 8), (1, 3)], "magic")
    sp.poly([(6, 3), (8.5, 4.5), (8.5, 7), (6, 8.5), (3.5, 7), (3.5, 4.5)], "glow")


def ic_ranged(sp: Sprite) -> None:  # 원거리: 화살
    sp.line(1, 10, 9, 2, "wood")
    sp.poly([(7, 1), (11, 0), (10, 4)], "steel")
    sp.line(0, 9, 2, 11, "white")
    sp.line(1, 8, 3, 10, "white")


def ic_onplay(sp: Sprite) -> None:  # 출진: 북
    sp.ellipse(6, 7, 5, 4, "red")
    sp.ellipse(6, 4.5, 5, 1.8, "cloth_tan")
    sp.line(1, 0, 4, 3, "wood")
    sp.line(11, 0, 8, 3, "wood")


def ic_ondeath(sp: Sprite) -> None:  # 유훈: 위패와 촛불
    sp.rect(3, 4, 8, 11, "wood")
    sp.rect(4, 5, 7, 10, "paper")
    sp.line(5, 6, 5, 9, "ink")
    sp.rect(9, 6, 10, 11, "white")
    sp.ellipse(9.8, 4, 1.2, 2, "fire")


def ic_mana(sp: Sprite) -> None:  # 마나: 엽전 구슬
    sp.ellipse(6, 6, 5.5, 5.5, "magic")
    sp.rect(5, 5, 6, 6, None)
    sp.px(3, 3, "glow")


def ic_attack(sp: Sprite) -> None:  # 공격: 칼
    sp.line(2, 9, 9, 2, "steel", 2)
    sp.line(1, 7, 4, 10, "gold")
    sp.px(1, 10, "wood")
    sp.px(0, 11, "wood")


def ic_health(sp: Sprite) -> None:  # 체력: 붉은 매듭
    sp.ellipse(3.8, 4.2, 3.2, 3.2, "red")
    sp.ellipse(8.2, 4.2, 3.2, 3.2, "red")
    sp.poly([(0.8, 5), (11.2, 5), (6, 11)], "red")
    sp.px(3, 3, "glow")


def ic_armor(sp: Sprite) -> None:  # 방어도: 둥근 등패
    sp.ellipse(6, 6, 5.5, 5.5, "steel")
    sp.ellipse(6, 6, 2.5, 2.5, "dark_steel")
    sp.px(6, 6, "gold")


def ic_durability(sp: Sprite) -> None:  # 내구도: 망치
    sp.line(2, 10, 7, 5, "wood", 1)
    sp.rect(5, 1, 10, 4, "dark_steel")


def ic_deck(sp: Sprite) -> None:
    sp.rect(2, 3, 9, 11, "navy")
    sp.rect(3, 1, 10, 9, "blue")
    sp.rect(5, 3, 8, 7, "gold")


def ic_fatigue(sp: Sprite) -> None:  # 피로: 빈 자루
    sp.ellipse(6, 7, 4.5, 4, "cloth_tan")
    sp.rect(5, 1, 7, 3, "rope")


def ic_power(sp: Sprite) -> None:  # 지휘관 능력: 지휘봉 깃발
    sp.line(2, 11, 2, 0, "wood")
    sp.poly([(3, 0), (11, 2), (3, 6)], "red")
    sp.px(5, 2, "gold")


ICON_ARTS: dict[str, Callable[[], Image.Image]] = {
    "ic-guard": icon(ic_guard),
    "ic-rush": icon(ic_rush),
    "ic-shield": icon(ic_shield),
    "ic-ranged": icon(ic_ranged),
    "ic-onplay": icon(ic_onplay),
    "ic-ondeath": icon(ic_ondeath),
    "ic-mana": icon(ic_mana),
    "ic-attack": icon(ic_attack),
    "ic-health": icon(ic_health),
    "ic-armor": icon(ic_armor),
    "ic-durability": icon(ic_durability),
    "ic-deck": icon(ic_deck),
    "ic-fatigue": icon(ic_fatigue),
    "ic-power": icon(ic_power),
}

# ---------------------------------------------------------------------------
# 카드 뒷면·전장 타일
# ---------------------------------------------------------------------------


def card_back() -> Image.Image:
    """카드 뒷면 16×22: 남색 바탕 + 단청풍 마름모 + 금 테."""
    sp = Sprite(16, 22)
    sp.rect(0, 0, 15, 21, "navy")
    sp.rect(1, 1, 14, 20, "blue")
    sp.rect(2, 2, 13, 19, "navy")
    sp.poly([(8, 4), (12, 11), (8, 18), (4, 11)], "crimson_seal")
    sp.poly([(8, 7), (10, 11), (8, 15), (6, 11)], "gold")
    for (x, y) in ((3, 3), (12, 3), (3, 18), (12, 18)):
        sp.px(x, y, "gold")
    return sp.render(outline=False)


def wall_tile() -> Image.Image:
    """성벽 48×24 (가로 이음): 성가퀴 + 돌쌓기."""
    w, h = 48, 24
    sp = Sprite(w, h)
    sp.rect(0, 6, w - 1, h - 1, "stone")
    for x in range(0, w, 12):
        sp.rect(x, 0, x + 7, 6, "stone")
        sp.rect(x + 3, 2, x + 4, 4, "ink")  # 총안
    img = sp.render(outline=False)
    arr = np.array(img)
    rng = np.random.default_rng(7)
    mortar = np.array([*MATERIALS["stone"][0], 255], dtype=np.uint8)
    hi = np.array([*MATERIALS["stone"][2], 255], dtype=np.uint8)
    for row, y in enumerate(range(8, h, 5)):
        arr[y, :, :] = mortar
        off = 0 if row % 2 == 0 else 4
        for x in range(off, w, 8):
            arr[y : min(h, y + 5), x, :] = mortar
            if y + 1 < h and x + 1 < w:
                arr[y + 1, x + 1 : min(w, x + 7), :] = hi
    noise = rng.integers(-10, 10, size=(h, w, 1))
    rgb = np.clip(arr[:, :, :3].astype(int) + noise, 0, 255).astype(np.uint8)
    arr[:, :, :3] = np.where(arr[:, :, 3:4] > 0, rgb, arr[:, :, :3])
    arr[6, :, :3] = np.array(MATERIALS["stone"][0]) // 2 + 20
    return Image.fromarray(arr, "RGBA")


def grass_tile() -> Image.Image:
    """들판 32×32 (이음): 풀 + 흙 얼룩."""
    rng = np.random.default_rng(11)
    base = np.array(MATERIALS["grass"][1], dtype=int)
    arr = np.zeros((32, 32, 4), dtype=np.uint8)
    for y in range(32):
        for x in range(32):
            v = rng.integers(-8, 8)
            arr[y, x, :3] = np.clip(base + v, 0, 255)
            arr[y, x, 3] = 255
    for _ in range(26):
        x, y = rng.integers(0, 32), rng.integers(0, 32)
        c = MATERIALS["grass"][2] if rng.random() < 0.6 else MATERIALS["grass"][0]
        arr[y, x, :3] = c
        arr[(y + 1) % 32, x, :3] = MATERIALS["grass"][0]
    for _ in range(6):
        x, y = rng.integers(0, 32), rng.integers(0, 32)
        arr[y, x, :3] = MATERIALS["dirt"][1]
        arr[y, (x + 1) % 32, :3] = MATERIALS["dirt"][2]
    for _ in range(3):
        x, y = rng.integers(0, 32), rng.integers(0, 32)
        arr[y, x, :3] = hx("f2e3a0")
    return Image.fromarray(arr, "RGBA")


def banner(mat: str) -> Callable[[], Image.Image]:
    def draw() -> Image.Image:
        sp = Sprite(14, 30)
        sp.line(2, 0, 2, 29, "wood")
        sp.poly([(3, 2), (13, 2), (13, 20), (8, 16), (3, 20)], mat)
        sp.rect(5, 6, 11, 11, "gold")
        sp.rect(7, 7, 9, 10, mat)
        sp.px(2, 0, "gold")
        return sp.render()

    return draw


EXTRA_ARTS: dict[str, Callable[[], Image.Image]] = {
    "card-back": card_back,
    "wall": wall_tile,
    "grass": grass_tile,
    "banner-ally": banner("blue"),
    "banner-enemy": banner("red"),
}

# ---------------------------------------------------------------------------
# 아틀라스
# ---------------------------------------------------------------------------


def read_art_keys() -> list[str]:
    text = CARDS_TS.read_text(encoding="utf-8")
    return sorted(set(re.findall(r'artKey:\s*"([^"]+)"', text)))


def pack(images: dict[str, Image.Image], width: int = 256) -> tuple[Image.Image, dict[str, tuple[int, int, int, int]]]:
    # 높이 내림차순 선반 배치
    order = sorted(images.items(), key=lambda kv: (-kv[1].height, kv[0]))
    x = y = shelf_h = 0
    coords: dict[str, tuple[int, int, int, int]] = {}
    for key, im in order:
        w, h = im.size
        if x + w > width:
            x = 0
            y += shelf_h + 1
            shelf_h = 0
        coords[key] = (x, y, w, h)
        x += w + 1
        shelf_h = max(shelf_h, h)
    height = y + shelf_h
    atlas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for key, im in images.items():
        cx, cy, _, _ = coords[key]
        atlas.paste(im, (cx, cy))
    return atlas, coords


def main() -> None:
    art_keys = read_art_keys()
    missing = [k for k in art_keys if k not in CARD_ARTS]
    if missing:
        raise SystemExit(f"그림이 없는 artKey: {missing}")
    images: dict[str, Image.Image] = {}
    for key in art_keys:
        images[key] = CARD_ARTS[key]()
    for key, fn in COMMANDER_ARTS.items():
        images[key] = fn()
    for key, fn in ICON_ARTS.items():
        images[key] = fn()
    for key, fn in EXTRA_ARTS.items():
        images[key] = fn()

    atlas, coords = pack(images)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    atlas_path = OUT_DIR / "battle-atlas.png"
    atlas.save(atlas_path, optimize=True)
    # 반복 배경용 타일은 따로도 저장한다 (background-repeat 는 아틀라스 조각에 쓸 수 없다)
    for key in ("wall", "grass"):
        images[key].save(OUT_DIR / f"tile-{key}.png", optimize=True)

    entries = ",\n".join(
        f'  "{k}": {{ x: {v[0]}, y: {v[1]}, w: {v[2]}, h: {v[3]} }}' for k, v in sorted(coords.items())
    )
    ts = (
        "// scripts/build-battle-art.py 가 생성한 파일 — 직접 수정하지 말 것.\n"
        "// 전투 픽셀 아트 아틀라스 좌표표.\n\n"
        "export interface AtlasRect {\n  x: number;\n  y: number;\n  w: number;\n  h: number;\n}\n\n"
        f'export const BATTLE_ATLAS_URL = "/battle/battle-atlas.png";\n'
        f"export const BATTLE_ATLAS_WIDTH = {atlas.width};\n"
        f"export const BATTLE_ATLAS_HEIGHT = {atlas.height};\n\n"
        f"export const BATTLE_ATLAS: Readonly<Record<string, AtlasRect>> = {{\n{entries},\n}};\n"
    )
    ATLAS_TS.parent.mkdir(parents=True, exist_ok=True)
    ATLAS_TS.write_text(ts, encoding="utf-8")

    # 확인용 4배 미리보기: python3 scripts/build-battle-art.py --preview out.png
    if "--preview" in sys.argv:
        prev_path = Path(sys.argv[sys.argv.index("--preview") + 1])
        preview = atlas.resize((atlas.width * 4, atlas.height * 4), Image.Resampling.NEAREST)
        bg = Image.new("RGBA", preview.size, (60, 70, 60, 255))
        bg.alpha_composite(preview)
        bg.save(prev_path)
    print(f"atlas {atlas.width}x{atlas.height} → {atlas_path} ({atlas_path.stat().st_size} bytes), {len(coords)} sprites")
    print(json.dumps({"artKeys": len(art_keys)}))


if __name__ == "__main__":
    main()
