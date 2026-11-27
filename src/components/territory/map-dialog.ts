import type { CastleBattleRequest } from "@/components/battle/AutoBattleHost";
import type { OutlawBattleRequest } from "@/components/battle/BattleHost";

export interface MarkerPanel {
  title: string;
  lines: string[];
  wildId?: number;
  /** 다른 영주의 부대·영주 (공격 버튼) */
  pvpTarget?: { type: "unit" | "lord"; ownerId: string; targetId: string; name: string };
  /** 자원지 (일꾼 보내기 버튼) */
  resourceNodeId?: string;
  eventKey?: string;
  isProximity?: boolean;
  lat?: number;
  lon?: number;
}

export interface ScoutResult {
  unitName: string;
  castles: { castleKey: string; name: string; distance: number; mine: boolean }[];
}

export type TerritorySheet = "castles" | "units" | "move" | "build" | "rank";

export type MapDialog =
  | { kind: "marker"; panel: MarkerPanel }
  | { kind: "castle" | "manage"; castleKey: string }
  | { kind: "sheet"; sheet: TerritorySheet }
  | { kind: "action"; title: string; message: string }
  | { kind: "scout"; result: ScoutResult }
  | { kind: "outlawFormation"; request: OutlawBattleRequest }
  | { kind: "castleFormation"; request: CastleBattleRequest }
  | { kind: "city" | "homePrompt" | "settings" | "start" | "battle" };
