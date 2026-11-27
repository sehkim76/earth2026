"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";

import type { BuildingKey } from "@/lib/city";
import { createCityWorld, type CityDistrict, type CityWorld } from "@/components/city/city-scene-engine";

export interface CitySceneLot {
  key: BuildingKey;
  name: string;
  level: number;
  /** 공사 중 */
  building: boolean;
  /** 훈련 중 */
  training: boolean;
  /** 공사·훈련 진행률 0~100 */
  progress: number;
  /** 남은 시간 글자 */
  remain: string | null;
}

interface CityScene3DProps {
  lots: CitySceneLot[];
  district: CityDistrict;
  siege: { active: boolean; wallLevel: number };
  selected: BuildingKey | null;
  onSelect: (key: BuildingKey) => void;
}

/** 성 안 3D 마당 (three.js). 이름표는 3D 위치를 따라다니는 HTML. */
export default function CityScene3D({ lots, district, siege: { active, wallLevel }, selected, onSelect }: CityScene3DProps): ReactElement | null {
  const [unavailable, setUnavailable] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<CityWorld | null>(null);
  const labelsRef = useRef(new Map<BuildingKey, HTMLDivElement>());
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const labels = labelsRef.current;
    let world: CityWorld;
    try {
      world = createCityWorld(host, {
        onPick: (k) => onSelectRef.current(k),
        labelFor: (k) => labels.get(k) ?? null,
      });
    } catch (error) {
      console.error("[city] 3D renderer unavailable", error);
      const timer = window.setTimeout(() => setUnavailable(true), 0);
      return () => window.clearTimeout(timer);
    }
    worldRef.current = world;
    return () => {
      world.dispose();
      worldRef.current = null;
    };
  }, []);

  const lotSig = lots.map((l) => `${l.key}:${l.level}:${l.building ? 1 : 0}`).join(",");
  useEffect(() => {
    worldRef.current?.setLots(lots.map((l) => ({ key: l.key, level: l.level, building: l.building })));
    // lotSig가 바뀔 때만 다시 짓는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lotSig]);

  useEffect(() => {
    worldRef.current?.setDistrict(district);
  }, [district]);

  useEffect(() => {
    worldRef.current?.setSiege(active, wallLevel);
  }, [active, wallLevel]);

  useEffect(() => {
    worldRef.current?.setSelected(selected);
  }, [selected]);

  if (unavailable) {
    return district === "buildings" ? (
      <div className="absolute inset-x-3 top-48 bottom-0 overflow-y-auto pb-6 text-[#f8e7c5] sm:left-5 sm:right-auto sm:w-80">
        <p className="mb-2 text-sm">3D 화면을 사용할 수 없습니다. 목록에서 건물을 선택하세요.</p>
        <div className="grid grid-cols-2 gap-2">
          {lots.map((lot) => (
            <button key={lot.key} type="button" data-city-surface="button" className="min-h-11 px-2 text-sm" onClick={() => onSelect(lot.key)}>
              {lot.name} · {lot.level ? `Lv.${lot.level}` : "미건설"}
            </button>
          ))}
        </div>
      </div>
    ) : null;
  }

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={hostRef} className="absolute inset-0" />
      <div data-city-labels className="pointer-events-none absolute inset-0">
        {lots.map((l) => (
          <div
            key={l.key}
            ref={(el) => {
              if (el) labelsRef.current.set(l.key, el);
              else labelsRef.current.delete(l.key);
            }}
            className="absolute left-0 top-0"
            style={{ transform: "translate(-9999px, 0)", visibility: "hidden" }}
          >
            <button
              type="button"
              disabled={district !== "buildings"}
              onClick={() => onSelect(l.key)}
              className={`pointer-events-auto flex flex-col items-center drop-shadow-[0_2px_3px_rgba(0,0,0,0.55)] transition active:scale-95 ${
                selected === l.key ? "scale-110" : ""
              }`}
            >
              {l.building || l.training ? (
                <span
                  className={`mb-0.5 flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px] font-black tabular-nums text-white ${
                    l.building ? "bg-[#c9852a]" : "bg-[#8e2f2f]"
                  }`}
                >
                  {l.building ? "공사" : "훈련"}
                  {l.remain ? <span>{l.remain}</span> : null}
                </span>
              ) : null}
              <span
                className={`flex items-center overflow-hidden rounded-md border text-[11px] font-black leading-none ${
                  l.level > 0 ? "border-[#e7c66f] bg-[#2a2016]/88 text-[#fff4d8]" : "border-dashed border-[#f3e8ce]/80 bg-black/45 text-[#f3e8ce]"
                }`}
              >
                <span className={`px-1.5 py-1 ${l.level > 0 ? "bg-[#e7c66f] text-[#2a2016]" : "bg-[#f3e8ce]/25"}`}>
                  {l.level > 0 ? l.level : "+"}
                </span>
                <span className="px-1.5 py-1">{l.name}</span>
              </span>
              {l.building || l.training ? (
                <span className="mt-0.5 h-1 w-14 overflow-hidden rounded bg-black/60">
                  <span
                    className={`block h-full ${l.building ? "bg-[#f0d99d]" : "bg-[#e88a7a]"}`}
                    style={{ width: `${Math.round(l.progress)}%` }}
                  />
                </span>
              ) : null}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
