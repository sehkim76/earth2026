import * as THREE from "three";

export type BlockState = "active" | "stopped" | "missed";

export type GameState = "loading" | "playing" | "ready" | "ended" | "reseting";

export type WorkingPlane = "x" | "z";

export type WorkingDimension = "width" | "depth";

export interface Dimension {
  width: number;
  height: number;
  depth: number;
}

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface BlockReturn {
  placed?: THREE.Mesh;
  chopped?: THREE.Mesh;
  plane: WorkingPlane;
  direction: number;
  bonus?: boolean;
}

export interface BlockSnapshot {
  dimension: Dimension;
  position: Position;
  direction: number;
  state: BlockState;
}

export interface TowerSnapshot {
  version: 1;
  state: GameState;
  deadlineMs: number | null;
  timeLeft: number;
  colorOffset: number;
  score: number;
  blocks: BlockSnapshot[];
}
