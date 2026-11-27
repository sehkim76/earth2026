// 성 안 건물·자원 아이콘 (인라인 SVG, 독자 디자인).

import type { ReactElement } from "react";

import type { BuildingKey, ResourceKind } from "@/lib/city";

const S = { stroke: "#2b2118", strokeWidth: 2, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };

export function BuildingIcon({ kind, size = 44 }: { kind: BuildingKey; size?: number }): ReactElement {
  const body = ((): ReactElement => {
    switch (kind) {
      case "keep":
        return (
          <>
            <rect x="12" y="20" width="24" height="22" fill="#c9b48c" {...S} />
            <path d="M12 20 v-5 h4 v3 h4 v-3 h4 v3 h4 v-3 h4 v5" fill="#c9b48c" {...S} />
            <rect x="21" y="30" width="6" height="12" fill="#5a3d24" {...S} />
            <path d="M24 15 V5" {...S} fill="none" />
            <path d="M24 5 l9 3 -9 3z" fill="#c0392b" {...S} />
          </>
        );
      case "storehouse":
        return (
          <>
            <path d="M8 22 L24 10 L40 22 V42 H8z" fill="#b5651d" {...S} />
            <rect x="17" y="27" width="14" height="15" fill="#7a4a1f" {...S} />
            <path d="M17 27 L31 42 M31 27 L17 42" {...S} fill="none" />
          </>
        );
      case "camp":
        return (
          <>
            <path d="M6 40 L24 10 L42 40z" fill="#d9c7a0" {...S} />
            <path d="M24 10 L19 40 H29z" fill="#8e7954" {...S} />
            <path d="M24 10 V5" {...S} fill="none" />
          </>
        );
      case "sawmill":
        return (
          <>
            <rect x="6" y="28" width="36" height="8" rx="4" fill="#a0703c" {...S} />
            <rect x="10" y="18" width="30" height="8" rx="4" fill="#b98448" {...S} />
            <circle cx="10" cy="22" r="3" fill="#e8c99a" {...S} />
            <circle cx="6" cy="32" r="3" fill="#e8c99a" {...S} />
            <path d="M33 8 l6 6 -10 10 -6 -6z" fill="#cfd6dc" {...S} />
          </>
        );
      case "quarry":
        return (
          <>
            <path d="M6 40 L14 24 L24 30 L32 18 L42 40z" fill="#9aa3ab" {...S} />
            <path d="M18 36 l4 -6 6 3" {...S} fill="none" />
            <path d="M34 8 l-10 10" {...S} />
            <path d="M30 6 l8 8" {...S} />
          </>
        );
      case "forge":
        return (
          <>
            <path d="M10 22 H38 L34 28 H28 V36 H34 V40 H14 V36 H20 V28 H14z" fill="#5b6770" {...S} />
            <path d="M30 6 l4 10 M26 10 l8 2" stroke="#f39c12" strokeWidth={2} strokeLinecap="round" />
          </>
        );
      case "mint":
        return (
          <>
            <ellipse cx="24" cy="36" rx="13" ry="4" fill="#d4a017" {...S} />
            <path d="M11 36 V30 M37 36 V30" {...S} />
            <ellipse cx="24" cy="30" rx="13" ry="4" fill="#f1c40f" {...S} />
            <ellipse cx="24" cy="22" rx="10" ry="3.5" fill="#f5d76e" {...S} />
            <path d="M14 22 V26 M34 22 V26" {...S} />
            <ellipse cx="24" cy="26" rx="10" ry="3.5" fill="none" {...S} />
          </>
        );
      case "academy":
        return (
          <>
            <path d="M6 18 L24 8 L42 18z" fill="#4f6d8f" {...S} />
            <rect x="9" y="18" width="30" height="22" fill="#e7dcc3" {...S} />
            <path d="M14 22 V36 M21 22 V36 M27 22 V36 M34 22 V36" {...S} />
          </>
        );
      case "barracks":
        return (
          <>
            <path d="M14 10 H34 V26 C34 34 24 40 24 40 C24 40 14 34 14 26z" fill="#8e2f2f" {...S} />
            <path d="M24 14 V34 M17 22 H31" stroke="#f3e8ce" strokeWidth={2.5} strokeLinecap="round" />
          </>
        );
      case "range":
        return (
          <>
            <circle cx="26" cy="26" r="14" fill="#f3e8ce" {...S} />
            <circle cx="26" cy="26" r="9" fill="#c0392b" {...S} />
            <circle cx="26" cy="26" r="4" fill="#f3e8ce" {...S} />
            <path d="M6 10 L26 26" {...S} />
            <path d="M6 10 l1 6 M6 10 l6 1" {...S} />
          </>
        );
      case "stable":
        return (
          <>
            <path d="M12 40 V22 A12 12 0 0 1 36 22 V40 H30 V24 A6 6 0 0 0 18 24 V40z" fill="#8e7954" {...S} />
            <circle cx="15" cy="38" r="1.5" fill="#2b2118" />
            <circle cx="33" cy="38" r="1.5" fill="#2b2118" />
          </>
        );
      case "wall":
        return (
          <>
            <path d="M6 42 V22 h5 v-5 h5 v5 h4 v-5 h8 v5 h4 v-5 h5 v5 h5 V42z" fill="#bfb49d" {...S} />
            <path d="M19 42 v-9 a5 5 0 0 1 10 0 v9z" fill="#3a2a1c" {...S} />
            <path d="M6 30 H19 M29 30 H42 M12 36 H19 M29 36 H36" {...S} fill="none" />
          </>
        );
      case "tower":
        return (
          <>
            <rect x="16" y="18" width="16" height="24" fill="#6c5a8e" {...S} />
            <path d="M12 18 L24 4 L36 18z" fill="#3f2f63" {...S} />
            <path d="M24 24 l2 4 4 0 -3 3 1 4 -4 -2 -4 2 1 -4 -3 -3 4 0z" fill="#f5d76e" stroke="#2b2118" strokeWidth={1} />
          </>
        );
    }
  })();
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      {body}
    </svg>
  );
}

const RES_COLOR: Readonly<Record<ResourceKind, string>> = {
  gold: "#f1c40f",
  stone: "#aab4bc",
  wood: "#a0703c",
  iron: "#6f8aa6",
};

export function ResourceIcon({ kind, size = 16 }: { kind: ResourceKind; size?: number }): ReactElement {
  const c = RES_COLOR[kind];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {kind === "gold" ? (
        <circle cx="8" cy="8" r="6" fill={c} stroke="#7a5a1e" strokeWidth={1.5} />
      ) : kind === "stone" ? (
        <path d="M2 12 L5 5 L10 3 L14 8 L12 13z" fill={c} stroke="#4a5258" strokeWidth={1.5} strokeLinejoin="round" />
      ) : kind === "wood" ? (
        <>
          <rect x="1.5" y="5" width="13" height="6" rx="3" fill={c} stroke="#4a2f14" strokeWidth={1.5} />
          <circle cx="4.5" cy="8" r="1.6" fill="#e8c99a" />
        </>
      ) : (
        <path d="M2 11 L5 5 H11 L14 11z" fill={c} stroke="#2e3e4e" strokeWidth={1.5} strokeLinejoin="round" />
      )}
    </svg>
  );
}
