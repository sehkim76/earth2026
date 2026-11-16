"use client";

import type { CSSProperties } from "react";

import { BATTLE_ATLAS, BATTLE_ATLAS_HEIGHT, BATTLE_ATLAS_URL, BATTLE_ATLAS_WIDTH } from "@/components/battle/battle-atlas";
import type { CommanderKind } from "@/lib/battle";

interface PixelArtProps {
  /** 아틀라스 키 (artKey, cmd-*, ic-* 등) */
  name: string;
  /** 한 픽셀 배율 */
  scale: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/** 아틀라스 조각 하나를 정수 배율로 그린다 (image-rendering: pixelated). */
export function PixelArt({ name, scale, className, style, title }: PixelArtProps) {
  const r = BATTLE_ATLAS[name];
  if (!r) return null;
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      className={className}
      style={{
        display: "inline-block",
        flex: "none",
        width: r.w * scale,
        height: r.h * scale,
        backgroundImage: `url(${BATTLE_ATLAS_URL})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${BATTLE_ATLAS_WIDTH * scale}px ${BATTLE_ATLAS_HEIGHT * scale}px`,
        backgroundPosition: `-${r.x * scale}px -${r.y * scale}px`,
        imageRendering: "pixelated",
        ...style,
      }}
    />
  );
}

export function commanderArtKey(kind: CommanderKind): string {
  return `cmd-${kind}`;
}
