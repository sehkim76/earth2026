"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";
import type { IScannerControls } from "@zxing/browser";
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  BoxGeometry,
  Camera,
  Clock,
  DirectionalLight,
  Euler,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Texture,
  LoadingManager,
  Raycaster,
  Vector3,
  Vector2,
  WebGLRenderer,
} from "three";
import type { BufferGeometry, Material } from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

type AnimationInfo = {
  resourceId: string;
  label: string;
  clipNames: string[];
};

type ArImageTargetModeProps = {
  onBackToQr?: () => void;
  onExitToMap: () => void;
  onQRDetected?: (decodedText: string) => void;
};

type TargetConfig = {
  resourceId: string;
  label: string;
  anchorIndex: number;
  objectType: "fbx" | "cube";
  modelPath?: string;
  targetCoverage: number;
  scaleMultiplier: number;
  rotationOffset: [number, number, number];
  position: [number, number, number];
};

type ReferenceImageLibraryAddressable = {
  key: string;
  imageTargetSrc: string;
  targets: TargetConfig[];
};

type CubeFaceKey = "TOP" | "BOTTOM" | "LEFT" | "RIGHT" | "FRONT" | "BACK";
type AxisKey = "x" | "y" | "z";

type FaceTransformConfig = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

const LP2_REFERENCE_IMAGE_LIBRARY: ReferenceImageLibraryAddressable = {
  key: "LP2ReferenceImageLibrary",
  imageTargetSrc: "/arqr-assets/image-targets/paperar.mind",
  targets: [
  {
    resourceId: "TOP",
    label: "사업가(TOP)",
    anchorIndex: 0,
    objectType: "cube",
    targetCoverage: 1,
    scaleMultiplier: 2,
    rotationOffset: [0, 0, 0],
    position: [0, 0, 0],
  },
  {
    resourceId: "BOTTOM",
    label: "지리학자(BOTTOM)",
    anchorIndex: 1,
    objectType: "cube",
    targetCoverage: 1,
    scaleMultiplier: 2,
    rotationOffset: [Math.PI, 0, 0],
    position: [0, 0, 0],
  },
  {
    resourceId: "LEFT",
    label: "허영심(LEFT)",
    anchorIndex: 2,
    objectType: "cube",
    targetCoverage: 1,
    scaleMultiplier: 2,
    rotationOffset: [0, 0, -Math.PI / 2],
    position: [0, 0, 0],
  },
  {
    resourceId: "RIGHT",
    label: "가로등(RIGHT)",
    anchorIndex: 3,
    objectType: "cube",
    targetCoverage: 1,
    scaleMultiplier: 2,
    rotationOffset: [0, 0, Math.PI / 2],
    position: [0, 0, 0],
  },
  {
    resourceId: "FRONT",
    label: "술주정뱅이(FRONT)",
    anchorIndex: 4,
    objectType: "cube",
    targetCoverage: 1,
    scaleMultiplier: 2,
    rotationOffset: [Math.PI * 1.5, 0, 0],
    position: [0, 0, 0],
  },
  {
    resourceId: "BACK",
    label: "임금님(BACK)",
    anchorIndex: 5,
    objectType: "cube",
    targetCoverage: 1,
    scaleMultiplier: 2,
    rotationOffset: [Math.PI / 2, 0, 0],
    position: [0, 0, 0],
  },
  {
    resourceId: "PAPERAR_KING",
    label: "KING",
    anchorIndex: 6,
    objectType: "fbx",
    modelPath: "/arqr-assets/models/paperar/PaperAR_King/king.fbx",
    targetCoverage: 0.9,
    scaleMultiplier: 1.1,
    rotationOffset: [Math.PI / 2, 0, 0],
    position: [0, 0, 0],
  },
  {
    resourceId: "PAPERAR_DRINKER",
    label: "DRINKER",
    anchorIndex: 7,
    objectType: "fbx",
    modelPath: "/arqr-assets/models/paperar/PaperARSec3Map/drinker.fbx",
    targetCoverage: 0.9,
    scaleMultiplier: 1.1,
    rotationOffset: [Math.PI / 2, 0, 0],
    position: [0, 0, 0],
  },
  {
    resourceId: "PAPERAR_BUSSINESSMAN",
    label: "BUSINESSMAN",
    anchorIndex: 8,
    objectType: "fbx",
    modelPath: "/arqr-assets/models/paperar/PaperARSec4Map/businessman.fbx",
    targetCoverage: 0.9,
    scaleMultiplier: 1.1,
    rotationOffset: [Math.PI / 2, 0, 0],
    position: [0, 0, 0],
  },
  {
    resourceId: "PAPERAR_SCHOLAR",
    label: "SCHOLAR",
    anchorIndex: 9,
    objectType: "fbx",
    modelPath: "/arqr-assets/models/paperar/PaperARSec6Map/scholar.fbx",
    targetCoverage: 0.9,
    scaleMultiplier: 1.1,
    rotationOffset: [Math.PI / 2, 0, 0],
    position: [0, 0, 0],
  },
  {
    resourceId: "PAPERAR_STREETLIGHT",
    label: "STREETLIGHT",
    anchorIndex: 10,
    objectType: "fbx",
    modelPath: "/arqr-assets/models/paperar/PaperARSec5Map/streetlight.fbx",
    targetCoverage: 0.9,
    scaleMultiplier: 1.1,
    rotationOffset: [Math.PI / 2, 0, 0],
    position: [0, 0, 0],
  },
  {
    resourceId: "PAPERAR_VANITY",
    label: "VANITY",
    anchorIndex: 11,
    objectType: "fbx",
    modelPath: "/arqr-assets/models/paperar/PaperARSec2Map/vanity.fbx",
    targetCoverage: 0.9,
    scaleMultiplier: 1.1,
    rotationOffset: [Math.PI / 2, 0, 0],
    position: [0, 0, 0],
  },
  ],
};

const CUBE_SIDE_LENGTH = 1;
const CUBE_PREFAB_SCALE = 0.5;
const CUBE_CENTER_OFFSET_SIGN = -1;
const TRANSITION_FACE_FILL_RATIO = 0.98;
const TRANSITION_SURFACE_GAP = -0.015;  // 원래 0.001;
const TRANSITION_DEPTH_OFFSET_RATIO = 0.12;
const TRANSITION_MAX_DEPTH_FOR_PLACEMENT = CUBE_SIDE_LENGTH * CUBE_PREFAB_SCALE * 0.35;
const TRACKING_FILTER_MIN_CF = 0.001;
const TRACKING_FILTER_BETA = 1000;
const TRACKING_WARMUP_TOLERANCE = 6;
const TRACKING_MISS_TOLERANCE = 8;
const TARGET_LOST_GRACE_MS = 180;
const TRANSITION_FACE_SCALE_MULTIPLIER: Record<CubeFaceKey, number> = {
  TOP: 1,
  BOTTOM: 1,
  LEFT: 1,
  RIGHT: 1,
  FRONT: 1,
  BACK: 1,
};

const STRETCH_FIT_FACES: Record<CubeFaceKey, boolean> = {
  TOP: false,
  BOTTOM: false,
  LEFT: true,
  RIGHT: false,
  FRONT: true,
  BACK: false,
};

// 임시: 큐브 면 전이 FBX(sec*transition_*.fbx)를 숨기려면 false 유지.
// 다시 보이게 하려면 true로 되돌리면 됨.
const SHOW_TRANSITION_MODELS = false;

const ENABLED_TRANSITION_FACES: Record<CubeFaceKey, boolean> = {
  TOP: true,
  BOTTOM: true,
  LEFT: true,
  RIGHT: true,
  FRONT: true,
  BACK: true,
};

const TRANSITION_MODEL_PATHS: Record<CubeFaceKey, string> = {
  TOP: "/arqr-assets/models/littleprince-cube/sec4transition_BusinessmanTop.fbx",
  BOTTOM: "/arqr-assets/models/littleprince-cube/sec6transition_ScholorBottom.fbx",
  LEFT: "/arqr-assets/models/littleprince-cube/sec2transition_VanityBack.fbx",
  FRONT: "/arqr-assets/models/littleprince-cube/sec3transition_DrinkerRight.fbx",
  RIGHT: "/arqr-assets/models/littleprince-cube/sec5transition_StreetLightsFront.fbx",
  BACK: "/arqr-assets/models/littleprince-cube/sec1transition_KingLeft.fbx",
};

const BOX_FACE_ORDER = ["RIGHT", "LEFT", "TOP", "BOTTOM", "FRONT", "BACK"] as const;
const CUBE_FACE_KEYS: CubeFaceKey[] = ["TOP", "BOTTOM", "LEFT", "RIGHT", "FRONT", "BACK"];

const BASE_CUBE_FACE_COLORS: Record<string, string> = {
  RIGHT: "#22c55e",
  LEFT: "#a855f7",
  TOP: "#f59e0b",
  BOTTOM: "#3b82f6",
  FRONT: "#ef4444",
  BACK: "#eab308",
};

const CUBE_SLOT_AXES: Record<CubeFaceKey, [number, number, number]> = {
  RIGHT: [1, 0, 0],
  LEFT: [-1, 0, 0],
  TOP: [0, 1, 0],
  BOTTOM: [0, -1, 0],
  FRONT: [0, 0, 1],
  BACK: [0, 0, -1],
};

type PhysicalDir = "up" | "bottom" | "front" | "back" | "left" | "right";

const PHYSICAL_FACE_COLORS: Record<PhysicalDir, string> = {
  up: "#ef4444",
  front: "#22c55e",
  right: "#f59e0b",
  back: "#a855f7",
  left: "#3b82f6",
  bottom: "#eab308",
};

const PHYSICAL_DIR_TO_FACE_KEY: Record<PhysicalDir, CubeFaceKey> = {
  up: "TOP",
  bottom: "BOTTOM",
  front: "FRONT",
  back: "BACK",
  left: "LEFT",
  right: "RIGHT",
};

const ANCHOR_FRAME_SPIN_STEPS: Record<string, number> = {
  TOP: 0,
  FRONT: 0,
  LEFT: 0,
  BOTTOM: 2,
  RIGHT: 0,
  BACK: 0,
};

type NetDir = "up" | "down" | "left" | "right";

// 종이를 접었을 때 net 방향 -> 물리 방향 (회전 없음 가정 시 고정).
const NET_DIR_TO_PHYSICAL: Record<string, Record<NetDir, PhysicalDir>> = {
  FRONT: { up: "up", down: "bottom", left: "left", right: "right" },
  RIGHT: { up: "up", down: "bottom", left: "front", right: "back" },
  BACK: { up: "up", down: "bottom", left: "right", right: "left" },
  LEFT: { up: "up", down: "bottom", left: "back", right: "front" },
  TOP: { up: "back", down: "front", left: "left", right: "right" },
  BOTTOM: { up: "front", down: "back", left: "left", right: "right" },
};

const OUTWARD_PHYSICAL: Record<string, PhysicalDir> = {
  TOP: "up",
  BOTTOM: "bottom",
  LEFT: "left",
  RIGHT: "right",
  FRONT: "front",
  BACK: "back",
};

const OPPOSITE_PHYSICAL: Record<string, PhysicalDir> = {
  TOP: "bottom",
  BOTTOM: "up",
  LEFT: "right",
  RIGHT: "left",
  FRONT: "back",
  BACK: "front",
};

const rotateNetDirCW = (
  dir: NetDir,
  steps: number
): NetDir => {
  const order: NetDir[] = ["up", "right", "down", "left"];
  const normalized = ((steps % 4) + 4) % 4;
  const idx = order.indexOf(dir);
  return order[(idx + normalized) % 4];
};

const resolvePhysicalDir = (
  target: TargetConfig,
  slotKey: CubeFaceKey
): PhysicalDir | null => {
  const axis = CUBE_SLOT_AXES[slotKey];
  const rotated = new Vector3(axis[0], axis[1], axis[2]).applyEuler(
    new Euler(target.rotationOffset[0], target.rotationOffset[1], target.rotationOffset[2])
  );
  const rx = Math.round(rotated.x);
  const ry = Math.round(rotated.y);
  const rz = Math.round(rotated.z);

  if (rz === 1) {
    return OUTWARD_PHYSICAL[target.resourceId] ?? null;
  }
  if (rz === -1) {
    return OPPOSITE_PHYSICAL[target.resourceId] ?? null;
  }

  let sourceDir: NetDir | null = null;
  if (rx === 1 && ry === 0) {
    sourceDir = "right";
  } else if (rx === -1 && ry === 0) {
    sourceDir = "left";
  } else if (rx === 0 && ry === 1) {
    sourceDir = "up";
  } else if (rx === 0 && ry === -1) {
    sourceDir = "down";
  }
  if (!sourceDir) {
    return null;
  }

  const steps = ANCHOR_FRAME_SPIN_STEPS[target.resourceId] ?? 0;
  const netDir = rotateNetDirCW(sourceDir, steps);
  return NET_DIR_TO_PHYSICAL[target.resourceId]?.[netDir] ?? null;
};

const TOUCH_AREA_TRANSFORMS: Record<CubeFaceKey, FaceTransformConfig> = {
  TOP: { position: [0, 0.35, 0], rotation: [0, 0, 0], scale: [0.5, 0.15, 0.5] },
  BOTTOM: { position: [0, -0.35, 0], rotation: [Math.PI, 0, 0], scale: [0.5, 0.15, 0.5] },
  LEFT: { position: [-0.35, 0, 0], rotation: [0, 0, Math.PI / 2], scale: [0.5, 0.15, 0.5] },
  RIGHT: { position: [0.35, 0, 0], rotation: [0, 0, -Math.PI / 2], scale: [0.5, 0.15, 0.5] },
  FRONT: { position: [0, 0, 0.35], rotation: [Math.PI / 2, 0, 0], scale: [0.5, 0.15, 0.5] },
  BACK: { position: [0, 0, -0.35], rotation: [-Math.PI / 2, 0, 0], scale: [0.5, 0.15, 0.5] },
};

const TRANSITION_FACE_ROTATIONS: Record<CubeFaceKey, [number, number, number]> = {
  TOP: [0, 0, 0],
  BOTTOM: [Math.PI, 0, 0],
  LEFT: [0, 0, Math.PI / 2],
  RIGHT: [0, 0, -Math.PI / 2],
  FRONT: [Math.PI / 2, 0, 0],
  BACK: [-Math.PI / 2, 0, 0],
};

const TRANSITION_FACE_NORMALS: Record<CubeFaceKey, Vector3> = {
  TOP: new Vector3(0, 1, 0),
  BOTTOM: new Vector3(0, -1, 0),
  LEFT: new Vector3(-1, 0, 0),
  RIGHT: new Vector3(1, 0, 0),
  FRONT: new Vector3(0, 0, 1),
  BACK: new Vector3(0, 0, -1),
};

const CUBE_FACE_VIDEO_URLS: Record<string, string> = {
  TOP: "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com/ARBOOK/Videos/ARBOOK_category_TOP.mp4",
  BOTTOM: "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com/ARBOOK/Videos/ARBOOK_category_BOTTOM.mp4",
  LEFT: "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com/ARBOOK/Videos/ARBOOK_category_LEFT.mp4",
  RIGHT: "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com/ARBOOK/Videos/ARBOOK_category_RIGHT.mp4",
  FRONT: "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com/ARBOOK/Videos/ARBOOK_category_FRONT.mp4",
  BACK: "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com/ARBOOK/Videos/ARBOOK_category_BACK.mp4",
};

const buildFallbackMesh = () => {
  const mesh = new Mesh(
    new BoxGeometry(0.2, 0.2, 0.2),
    new MeshStandardMaterial({ color: "#22d3ee", metalness: 0.15, roughness: 0.35 })
  );
  mesh.position.set(0, 0.05, 0);
  return mesh;
};

const applyTargetTransform = (object: Group, target: TargetConfig) => {
  object.rotation.set(target.rotationOffset[0], target.rotationOffset[1], target.rotationOffset[2]);

  const sourceBox = new Box3().setFromObject(object);
  const sourceSize = sourceBox.getSize(new Vector3());
  const sourceWidth = sourceSize.x;
  const sourceHeight = sourceSize.y;

  if (sourceWidth > 0 && sourceHeight > 0) {
    const fittedScaleX = (target.targetCoverage / sourceWidth) * target.scaleMultiplier;
    const fittedScaleY = (target.targetCoverage / sourceHeight) * target.scaleMultiplier;
    const fittedScaleZ = Math.min(fittedScaleX, fittedScaleY);
    object.scale.set(fittedScaleX, fittedScaleY, fittedScaleZ);
  } else {
    object.scale.setScalar(target.scaleMultiplier);
  }

  const fittedBox = new Box3().setFromObject(object);
  const groundOffset = Number.isFinite(fittedBox.min.y) ? -fittedBox.min.y : 0;
  object.position.set(target.position[0], target.position[1] + groundOffset, target.position[2]);
};

const getAxisSize = (size: Vector3, axis: AxisKey): number => {
  if (axis === "x") {
    return size.x;
  }

  if (axis === "y") {
    return size.y;
  }

  return size.z;
};

const TRANSITION_FACE_AXIS_CONFIG: Record<
  CubeFaceKey,
  { planeA: AxisKey; planeB: AxisKey; depth: AxisKey }
> = {
  TOP: { planeA: "x", planeB: "z", depth: "y" },
  BOTTOM: { planeA: "x", planeB: "z", depth: "y" },
  LEFT: { planeA: "y", planeB: "z", depth: "x" },
  RIGHT: { planeA: "y", planeB: "z", depth: "x" },
  FRONT: { planeA: "x", planeB: "y", depth: "z" },
  BACK: { planeA: "x", planeB: "y", depth: "z" },
};

const LOCAL_AXES: AxisKey[] = ["x", "y", "z"];

const dominantAxis = (direction: Vector3): AxisKey => {
  const ax = Math.abs(direction.x);
  const ay = Math.abs(direction.y);
  const az = Math.abs(direction.z);
  if (ax >= ay && ax >= az) {
    return "x";
  }
  if (ay >= ax && ay >= az) {
    return "y";
  }
  return "z";
};

const unitVectorOf = (axis: AxisKey): Vector3 =>
  new Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);

const fitModelToFace = (
  object: Object3D,
  faceKey: CubeFaceKey,
  targetFaceSize: number,
  stretch: boolean
): Vector3 | null => {
  const axisConfig = TRANSITION_FACE_AXIS_CONFIG[faceKey];
  const faceRotation = TRANSITION_FACE_ROTATIONS[faceKey];
  const slotQuaternion = new Quaternion().setFromEuler(
    new Euler(faceRotation[0], faceRotation[1], faceRotation[2])
  );

  const nativeBox = new Box3().setFromObject(object);
  const nativeSize = nativeBox.getSize(new Vector3());
  object.position.sub(nativeBox.getCenter(new Vector3()));
  object.rotation.set(faceRotation[0], faceRotation[1], faceRotation[2]);

  const faceDim: Record<AxisKey, number> = { x: 0, y: 0, z: 0 };
  LOCAL_AXES.forEach((localAxis) => {
    faceDim[dominantAxis(unitVectorOf(localAxis).applyQuaternion(slotQuaternion))] =
      getAxisSize(nativeSize, localAxis);
  });

  const planeDimA = faceDim[axisConfig.planeA];
  const planeDimB = faceDim[axisConfig.planeB];
  if (!Number.isFinite(planeDimA) || !Number.isFinite(planeDimB) || planeDimA <= 0 || planeDimB <= 0) {
    return null;
  }

  const fitA = targetFaceSize / planeDimA;
  const fitB = targetFaceSize / planeDimB;
  const faceScales: Record<AxisKey, number> = {
    x: Math.min(fitA, fitB),
    y: Math.min(fitA, fitB),
    z: Math.min(fitA, fitB),
  };
  if (stretch) {
    faceScales[axisConfig.planeA] = fitA;
    faceScales[axisConfig.planeB] = fitB;
  }

  const localScales: Record<AxisKey, number> = { x: 1, y: 1, z: 1 };
  LOCAL_AXES.forEach((localAxis) => {
    localScales[localAxis] =
      faceScales[dominantAxis(unitVectorOf(localAxis).applyQuaternion(slotQuaternion))];
  });

  const currentScale = object.scale.clone();
  object.scale.set(
    currentScale.x * localScales.x,
    currentScale.y * localScales.y,
    currentScale.z * localScales.z
  );

  const depthSize = faceDim[axisConfig.depth] * faceScales[axisConfig.depth];
  const depthForPlacement = Math.min(depthSize, TRANSITION_MAX_DEPTH_FOR_PLACEMENT);
  const halfCube = (CUBE_SIDE_LENGTH * CUBE_PREFAB_SCALE) / 2;
  const normal = TRANSITION_FACE_NORMALS[faceKey];
  const placementDistance =
    halfCube + depthForPlacement * TRANSITION_DEPTH_OFFSET_RATIO + TRANSITION_SURFACE_GAP;

  object.position.set(
    normal.x * placementDistance,
    normal.y * placementDistance,
    normal.z * placementDistance
  );

  return new Vector3(
    faceDim.x * faceScales.x,
    faceDim.y * faceScales.y,
    faceDim.z * faceScales.z
  );
};

const normalizeTransitionModelScale = (
  object: Object3D,
  faceKey: CubeFaceKey
): Vector3 | null => {
  const targetFaceSize =
    CUBE_SIDE_LENGTH
    * CUBE_PREFAB_SCALE
    * TRANSITION_FACE_FILL_RATIO
    * TRANSITION_FACE_SCALE_MULTIPLIER[faceKey];
  return fitModelToFace(object, faceKey, targetFaceSize, STRETCH_FIT_FACES[faceKey] ?? false);
};

const normalizeTransitionModelToSize = (
  object: Object3D,
  scaleFace: CubeFaceKey,
  placeFace: CubeFaceKey
): Vector3 | null => {
  if (scaleFace === placeFace) {
    return normalizeTransitionModelScale(object, placeFace);
  }

  const targetFaceSize =
    CUBE_SIDE_LENGTH *
    CUBE_PREFAB_SCALE *
    TRANSITION_FACE_FILL_RATIO *
    TRANSITION_FACE_SCALE_MULTIPLIER[scaleFace];
  return fitModelToFace(object, placeFace, targetFaceSize, STRETCH_FIT_FACES[scaleFace] ?? false);
};

const loadReferenceImageLibraryAddressable = async () => {
  const response = await fetch(LP2_REFERENCE_IMAGE_LIBRARY.imageTargetSrc, {
    method: "HEAD",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`reference image library load failed: ${response.status}`);
  }
  return LP2_REFERENCE_IMAGE_LIBRARY;
};

const loadTransitionModel = (
  loader: FBXLoader,
  modelPath: string,
  modelCache: Map<string, Promise<Object3D>>
): Promise<Object3D> => {
  const cachedModel = modelCache.get(modelPath);
  if (cachedModel) {
    return cachedModel;
  }

  const modelPromise = new Promise<Object3D>((resolve) => {
    loader.load(
      modelPath,
      resolve,
      undefined,
      () => {
        resolve(buildFallbackMesh());
      }
    );
  });
  modelCache.set(modelPath, modelPromise);
  return modelPromise;
};

const loadAddressableModel = async (
  loader: FBXLoader,
  target: TargetConfig,
  transitionModelCache: Map<string, Promise<Object3D>>,
  onStoriesFitted?: (resourceId: string, summary: string) => void
) => {
  if (target.objectType === "cube") {
    const cubeMaterials = BOX_FACE_ORDER.map((slotKey) => {
      const physicalDir = resolvePhysicalDir(target, slotKey);
      return new MeshStandardMaterial({
        color: (physicalDir ? PHYSICAL_FACE_COLORS[physicalDir] : BASE_CUBE_FACE_COLORS[slotKey]) ?? "#ffffff",
        transparent: true,
        opacity: 0.48,
        metalness: 0,
        roughness: 0.85,
      });
    });

    const cubeHalfExtent =
      (CUBE_SIDE_LENGTH * CUBE_PREFAB_SCALE * target.scaleMultiplier) / 2;
    const cubeCenterOffset = cubeHalfExtent * CUBE_CENTER_OFFSET_SIGN;

    const wrapper = new Group();
    wrapper.name = "ARObject_EDBOX_LittlePrince수정";
    wrapper.position.set(
      target.position[0],
      target.position[1],
      target.position[2] + cubeCenterOffset
    );
    wrapper.rotation.set(target.rotationOffset[0], target.rotationOffset[1], target.rotationOffset[2]);
    wrapper.scale.setScalar(target.scaleMultiplier);

    const wavesGroup = new Group();
    wavesGroup.name = "Waves";
    wrapper.add(wavesGroup);

    const cube = new Mesh(
      new BoxGeometry(CUBE_SIDE_LENGTH, CUBE_SIDE_LENGTH, CUBE_SIDE_LENGTH),
      cubeMaterials
    );
    cube.name = "Cube";
    cube.scale.set(CUBE_PREFAB_SCALE, CUBE_PREFAB_SCALE, CUBE_PREFAB_SCALE);
    cube.position.set(0, 0, 0);
    cube.castShadow = true;
    cube.receiveShadow = true;
    wavesGroup.add(cube);

    const touchAreas = new Group();
    touchAreas.name = "TouchAreas";
    wrapper.add(touchAreas);

    CUBE_FACE_KEYS.forEach((faceKey) => {
      const touchTransform = TOUCH_AREA_TRANSFORMS[faceKey];
      const touchArea = new Mesh(
        new BoxGeometry(1, 1, 1),
        new MeshStandardMaterial({
          color: "#ffffff",
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      );

      touchArea.name = `TouchArea_${faceKey}`;
      touchArea.position.set(
        touchTransform.position[0],
        touchTransform.position[1],
        touchTransform.position[2]
      );
      touchArea.rotation.set(
        touchTransform.rotation[0],
        touchTransform.rotation[1],
        touchTransform.rotation[2]
      );
      touchArea.scale.set(touchTransform.scale[0], touchTransform.scale[1], touchTransform.scale[2]);
      const touchPhysicalDir = resolvePhysicalDir(target, faceKey);
      touchArea.userData = {
        isTouchArea: true,
        faceKey: touchPhysicalDir ? PHYSICAL_DIR_TO_FACE_KEY[touchPhysicalDir] : faceKey,
        resourceId: target.resourceId,
      };

      touchAreas.add(touchArea);
    });

    const gluedSlots = CUBE_FACE_KEYS.filter((slotKey) => {
      const physicalDir = resolvePhysicalDir(target, slotKey);
      const modelKey = physicalDir ? PHYSICAL_DIR_TO_FACE_KEY[physicalDir] : null;
      return (
        modelKey !== null &&
        (SHOW_TRANSITION_MODELS || ENABLED_TRANSITION_FACES[modelKey])
      );
    });
    if (gluedSlots.length > 0) {
      const fittedStories: Array<{ modelKey: string; worldSize: string }> = [];
      await Promise.all(
        gluedSlots.map(async (slotKey) => {
          const physicalDir = resolvePhysicalDir(target, slotKey);
          if (!physicalDir) {
            return;
          }
          const modelKey = PHYSICAL_DIR_TO_FACE_KEY[physicalDir];
          const gluedModel = cloneSkeleton(
            await loadTransitionModel(loader, TRANSITION_MODEL_PATHS[modelKey], transitionModelCache)
          );
          gluedModel.name = `${modelKey}SideObject`;
          const nativeBox = new Box3().setFromObject(gluedModel);
          const nativeSize = nativeBox.getSize(new Vector3());
          const fittedSize = normalizeTransitionModelToSize(gluedModel, modelKey, slotKey);
          if (!fittedSize) {
            return;
          }
          fittedStories.push({
            modelKey,
            worldSize:
              [fittedSize.x, fittedSize.y, fittedSize.z]
                .map((v) => (v * target.scaleMultiplier).toFixed(2))
                .join("x") +
              "(nat:" +
              [nativeSize.x, nativeSize.y, nativeSize.z].map((v) => v.toFixed(0)).join("x") +
              ")",
          });
          gluedModel.traverse((node) => {
            if (!(node instanceof Mesh)) {
              return;
            }

            node.castShadow = true;
            node.receiveShadow = true;
            node.userData = {
              ...node.userData,
              isTransitionPlane: true,
              faceKey: slotKey,
              resourceId: target.resourceId,
            };
          });
          wavesGroup.add(gluedModel);
        })
      );
      if (onStoriesFitted) {
        const summary = fittedStories
          .sort((a, b) => (a.modelKey < b.modelKey ? -1 : 1))
          .map((entry) => `${entry.modelKey}:${entry.worldSize}`)
          .join(" ");
        onStoriesFitted(target.resourceId, summary);
      }
    }

    return Promise.resolve(wrapper);
  }

  if (!target.modelPath) {
    return Promise.resolve(buildFallbackMesh());
  }

  const modelPath = target.modelPath;

  return new Promise<Object3D>((resolve) => {
    loader.load(
      modelPath,
      (object) => {
        console.log(`[FBX] Loaded ${target.label}:`, {
          type: object.type,
          isGroup: object instanceof Group,
          rootAnimations: object.animations?.length || 0,
          childrenCount: object.children?.length || 0,
        });

        object.traverse((child) => {
          if (child instanceof Group) {
            console.log(`[FBX] ${target.label} child:`, {
              name: child.name,
              animations: child.animations?.length || 0,
            });
          }
        });

        applyTargetTransform(object, target);
        resolve(object);
      },
      undefined,
      (error) => {
        console.error(`[FBX] Failed to load ${target.label}:`, error);
        resolve(buildFallbackMesh());
      }
    );
  });
};

const FBM_IMAGE_WARN_TEXT = "FBXLoader: Image type \"fbm\" is not supported.";
const TRANSPARENT_PIXEL_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZVh0AAAAASUVORK5CYII=";

const describeImageMapping = (resourceId: string): string => {
  const target = LP2_REFERENCE_IMAGE_LIBRARY.targets.find(
    (candidate) => candidate.resourceId === resourceId
  );
  if (!target || target.objectType !== "cube") {
    return "";
  }
  const storyAt: Record<string, string> = {};
  CUBE_FACE_KEYS.forEach((slotKey) => {
    const axis = CUBE_SLOT_AXES[slotKey];
    const rotated = new Vector3(axis[0], axis[1], axis[2]).applyEuler(
      new Euler(target.rotationOffset[0], target.rotationOffset[1], target.rotationOffset[2])
    );
    const key = `${Math.round(rotated.x)},${Math.round(rotated.y)},${Math.round(rotated.z)}`;
    const physicalDir = resolvePhysicalDir(target, slotKey);
    const story = physicalDir ? PHYSICAL_DIR_TO_FACE_KEY[physicalDir] : "?";
    if (key === "0,1,0") {
      storyAt.up = story;
    } else if (key === "1,0,0") {
      storyAt.right = story;
    } else if (key === "0,-1,0") {
      storyAt.down = story;
    } else if (key === "-1,0,0") {
      storyAt.left = story;
    }
  });
  return `위:${storyAt.up ?? "?"} 오:${storyAt.right ?? "?"} 아래:${storyAt.down ?? "?"} 왼:${storyAt.left ?? "?"}`;
};

export default function ArImageTargetMode({ onBackToQr, onExitToMap, onQRDetected }: ArImageTargetModeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeResourceIdRef = useRef<string | null>(null);
  const [statusText, setStatusText] = useState("Image Target AR 준비 중...");
  const [activeTarget, setActiveTarget] = useState("");
  const [activeResourceKey, setActiveResourceKey] = useState("");
  const [storySizes, setStorySizes] = useState<Record<string, string>>({});
  const [errorText, setErrorText] = useState("");
  const [cubeVideoSrc, setCubeVideoSrc] = useState("");
  const [animationInfo, setAnimationInfo] = useState<AnimationInfo[]>([]);
  const [qrDetectedText, setQrDetectedText] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isInfoPanelCollapsed, setIsInfoPanelCollapsed] = useState(false);
  const [objectsVisible, setObjectsVisible] = useState(true);
  const sceneRef = useRef<{ visible: boolean } | null>(null);

  useEffect(() => {
    if (sceneRef.current) {
      sceneRef.current.visible = objectsVisible;
    }
  }, [objectsVisible]);

  useEffect(() => {
    let disposed = false;
    let resourcesReady = false;
    let pendingTargetStatusText = "타겟을 인식 중입니다.";
    let mindar: {
      renderer: WebGLRenderer;
      stop: () => Promise<void> | void;
    } | null = null;
    let detachResizeListener: (() => void) | null = null;
    let detachPointerListener: (() => void) | null = null;
    let qrStartupTimeoutId: number | null = null;
    let qrDecoderControls: IScannerControls | null = null;
    let qrDetected = false;
    const loadedObjects: Object3D[] = [];
    const clickableCubes: Mesh[] = [];
    const transitionModelCache = new Map<string, Promise<Object3D>>();
    const disposedGeometries = new Set<BufferGeometry>();
    const disposedMaterials = new Set<Material>();
    const disposedTextures = new Set<Texture>();
    const pendingLossByResource = new Map<string, number>();
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let interactionCamera: Camera | null = null;
    let interactionRenderer: WebGLRenderer | null = null;

    const clearPendingLoss = (resourceId: string) => {
      const timeoutId = pendingLossByResource.get(resourceId);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        pendingLossByResource.delete(resourceId);
      }
    };

    const clearAllPendingLoss = () => {
      pendingLossByResource.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      pendingLossByResource.clear();
    };

    const TARGET_SWITCH_DEBOUNCE_MS = 300;
    let pendingSwitchTimeout: number | null = null;
    let pendingSwitchResourceId: string | null = null;

    const clearPendingSwitch = () => {
      if (pendingSwitchTimeout !== null) {
        window.clearTimeout(pendingSwitchTimeout);
        pendingSwitchTimeout = null;
      }
      pendingSwitchResourceId = null;
    };

    const disposeObject3D = (root: Object3D) => {
      const disposeMaterialTextures = (material: Material) => {
        Object.values(material).forEach((value) => {
          if (value instanceof Texture && !disposedTextures.has(value)) {
            disposedTextures.add(value);
            value.dispose();
          }
        });
      };

      root.traverse((node) => {
        if (!(node instanceof Mesh)) {
          return;
        }

        if (!disposedGeometries.has(node.geometry)) {
          disposedGeometries.add(node.geometry);
          node.geometry.dispose();
        }

        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => {
          if (disposedMaterials.has(material)) {
            return;
          }

          disposedMaterials.add(material);
          disposeMaterialTextures(material);
          material.dispose();
        });
      });
    };

    const reportQrFailure = (error: unknown) => {
      console.error("[QR] Decoder failed:", error);
      if (disposed) {
        return;
      }

      setStatusText("QR 스캔을 사용할 수 없습니다. AR 카메라는 계속 실행 중입니다.");
      setErrorText("QR 스캐너를 시작하지 못했습니다. AR 카메라는 계속 사용할 수 있습니다.");
    };

    const stopQrDecoder = () => {
      const controls = qrDecoderControls;
      qrDecoderControls = null;
      controls?.stop();
    };

    const boot = async () => {
      if (!containerRef.current) {
        return;
      }

      try {
        const mindarLib = await import("@/lib/mindar/mindar-image-three.prod.js");

        if (disposed) {
          return;
        }

        setStatusText("LP2ReferenceImageLibrary Addressable 로드 중...");
        const referenceLibrary = await loadReferenceImageLibraryAddressable();
        if (disposed) {
          return;
        }

        const mindarThree = new mindarLib.MindARThree({
          container: containerRef.current,
          imageTargetSrc: referenceLibrary.imageTargetSrc,
          maxTrack: 1,
          filterMinCF: TRACKING_FILTER_MIN_CF,
          filterBeta: TRACKING_FILTER_BETA,
          warmupTolerance: TRACKING_WARMUP_TOLERANCE,
          missTolerance: TRACKING_MISS_TOLERANCE,
          uiLoading: "no",
          uiScanning: "no",
          uiError: "no",
        });

        mindar = mindarThree;

        const { scene, camera, renderer } = mindarThree;
        sceneRef.current = scene;
        const clock = new Clock();
        const mixers: AnimationMixer[] = [];
        interactionCamera = camera;
        interactionRenderer = renderer;

        const ambient = new AmbientLight("#ffffff", 0.9);
        const directional = new DirectionalLight("#ffffff", 0.8);
        directional.position.copy(new Vector3(0, 1.5, 0.8));
        scene.add(ambient);
        scene.add(directional);

        const loadingManager = new LoadingManager();
        loadingManager.setURLModifier((url) => {
          const normalizedUrl = url.split("?")[0].toLowerCase();
          if (normalizedUrl.endsWith(".fbm")) {
            return TRANSPARENT_PIXEL_DATA_URL;
          }
          return url;
        });

        const loader = new FBXLoader(loadingManager);
        const objectRegistry = new Map<string, Object3D>();
        const anchorRegistry = new Map<string, Group>();

        const setActiveResource = (resourceId: string | null) => {
          activeResourceIdRef.current = resourceId;
          anchorRegistry.forEach((group, key) => {
            group.visible = resourceId !== null && key === resourceId;
          });
        };

        const sortedIndices = [...referenceLibrary.targets]
          .map((target) => target.anchorIndex)
          .sort((a, b) => a - b);
        const hasAnchorGap = sortedIndices.some((index, idx) => index !== idx);
        if (hasAnchorGap) {
          throw new Error("Invalid anchor index mapping: expected contiguous 0..N order");
        }

        referenceLibrary.targets.forEach((target) => {
          const anchorWithCallbacks: {
            group: Group;
            onTargetFound: (() => void) | null;
            onTargetLost: (() => void) | null;
          } = mindarThree.addAnchor(target.anchorIndex);

          anchorRegistry.set(target.resourceId, anchorWithCallbacks.group);
          anchorWithCallbacks.group.visible = false;

          anchorWithCallbacks.onTargetFound = () => {
            if (disposed) {
              return;
            }

            clearPendingLoss(target.resourceId);

            if (activeResourceIdRef.current === target.resourceId) {
              clearPendingSwitch();
              return;
            }

            const activateTarget = () => {
              if (disposed) {
                return;
              }
              setActiveResource(target.resourceId);
              setActiveResourceKey(target.resourceId);
              setActiveTarget(target.label);
              pendingTargetStatusText = `타겟 인식됨: ${target.label}`;
              if (resourcesReady) {
                setStatusText(pendingTargetStatusText);
              }
            };

            if (activeResourceIdRef.current === null) {
              clearPendingSwitch();
              activateTarget();
              return;
            }

            if (pendingSwitchResourceId === target.resourceId) {
              return;
            }
            clearPendingSwitch();
            pendingSwitchResourceId = target.resourceId;
            pendingSwitchTimeout = window.setTimeout(() => {
              pendingSwitchTimeout = null;
              pendingSwitchResourceId = null;
              if (activeResourceIdRef.current === target.resourceId) {
                return;
              }
              activateTarget();
            }, TARGET_SWITCH_DEBOUNCE_MS);
          };

          anchorWithCallbacks.onTargetLost = () => {
            if (pendingSwitchResourceId === target.resourceId) {
              clearPendingSwitch();
            }
            if (disposed || activeResourceIdRef.current !== target.resourceId) {
              return;
            }

            clearPendingLoss(target.resourceId);
            const timeoutId = window.setTimeout(() => {
              pendingLossByResource.delete(target.resourceId);
              if (disposed || activeResourceIdRef.current !== target.resourceId) {
                return;
              }

              setActiveResource(null);
              setCubeVideoSrc("");
              setActiveResourceKey("");
              setActiveTarget("");
              pendingTargetStatusText = "타겟을 화면 중앙에 맞춰주세요.";
              if (resourcesReady) {
                setStatusText(pendingTargetStatusText);
              }
            }, TARGET_LOST_GRACE_MS);
            pendingLossByResource.set(target.resourceId, timeoutId);
          };
        });

        if (disposed) {
          mindarThree.stop();
          return;
        }

        await mindarThree.start();

        if (disposed) {
          mindarThree.stop();
          return;
        }

        const container = containerRef.current;

        if (container) {
          const handlePointerDown = (event: PointerEvent) => {
            if (!interactionRenderer || !interactionCamera || !clickableCubes.length) {
              return;
            }

            const rect = interactionRenderer.domElement.getBoundingClientRect();
            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            raycaster.setFromCamera(pointer, interactionCamera);
            const intersects = raycaster.intersectObjects(clickableCubes, false);
            if (!intersects.length) {
              return;
            }

            const isWorldVisible = (mesh: Object3D) => {
              let current: Object3D | null = mesh;
              while (current) {
                if (!current.visible) {
                  return false;
                }
                current = current.parent;
              }
              return true;
            };

            const hit = intersects.find((intersection) => {
              const resourceId = intersection.object.userData?.resourceId;
              return (
                typeof resourceId === "string" &&
                resourceId === activeResourceIdRef.current &&
                isWorldVisible(intersection.object)
              );
            });
            if (!hit) {
              return;
            }

            const directFaceKey = hit.object.userData?.faceKey;
            const materialIndex = hit.face?.materialIndex ?? Math.floor((hit.faceIndex ?? 0) / 2);
            const clampedMaterialIndex = Math.max(0, Math.min(BOX_FACE_ORDER.length - 1, materialIndex));
            const fallbackFaceKey = BOX_FACE_ORDER[clampedMaterialIndex];
            const faceKey = (typeof directFaceKey === "string" ? directFaceKey : fallbackFaceKey) as CubeFaceKey;
            const activeResourceId = activeResourceIdRef.current;
            if (!activeResourceId) {
              return;
            }
            setStatusText(`큐브 면 선택: ${faceKey}`);
            const mappedVideo = CUBE_FACE_VIDEO_URLS[faceKey];
            if (mappedVideo) {
              setCubeVideoSrc(mappedVideo);
            }
          };

          container.addEventListener("pointerdown", handlePointerDown);
          detachPointerListener = () => {
            container.removeEventListener("pointerdown", handlePointerDown);
          };

          const applyPreviewLayout = () => {
            const videoElement = container.querySelector("video");
            if (videoElement) {
              videoElement.style.position = "absolute";
              videoElement.style.left = "0";
              videoElement.style.top = "0";
              videoElement.style.width = "100%";
              videoElement.style.height = "100%";
              videoElement.style.objectFit = "cover";
              videoElement.style.zIndex = "0";
            }

            const canvasElements = Array.from(container.querySelectorAll("canvas"));
            canvasElements.forEach((canvas, index) => {
              canvas.style.position = "absolute";
              canvas.style.left = "0";
              canvas.style.top = "0";
              canvas.style.width = "100%";
              canvas.style.height = "100%";
              canvas.style.zIndex = String(index + 1);
              canvas.style.pointerEvents = "none";
            });
          };

          applyPreviewLayout();

          const handleResize = () => {
            window.requestAnimationFrame(applyPreviewLayout);
          };

          window.addEventListener("resize", handleResize);
          detachResizeListener = () => {
            window.removeEventListener("resize", handleResize);
          };
        }

        if (disposed) {
          mindarThree.stop();
          return;
        }

        renderer.setAnimationLoop(() => {
          const delta = clock.getDelta();

          mixers.forEach((mixer) => {
            mixer.update(delta);
          });

          renderer.render(scene, camera);
        });

        const originalConsoleWarn = console.warn;
        console.warn = (...args: unknown[]) => {
          const firstArg = args[0];
          if (typeof firstArg === "string" && firstArg.includes(FBM_IMAGE_WARN_TEXT)) {
            return;
          }
          originalConsoleWarn(...args);
        };

        try {
          await Promise.all(
            referenceLibrary.targets.map(async (target) => {
              const object = await loadAddressableModel(loader, target, transitionModelCache, (resourceId, summary) => {
                if (disposed) {
                  return;
                }
                setStorySizes((previous) => ({ ...previous, [resourceId]: summary }));
              });

              if (disposed) {
                disposeObject3D(object);
                return;
              }

              if (target.objectType === "cube") {
                object.traverse((node) => {
                  if (node instanceof Mesh && Boolean(node.userData?.isTouchArea)) {
                    clickableCubes.push(node);
                  }
                });
              }

              if (target.objectType === "fbx" && object instanceof Group) {
                const fbxAnimations = object.animations.length > 0 ? object.animations : [];

                object.traverse((child) => {
                  if (child instanceof Group && child.animations && child.animations.length > 0) {
                    console.log(`[AnimationMixer] ${target.label} child "${child.name}" has ${child.animations.length} animations`);
                    fbxAnimations.push(...child.animations);
                  }
                });

                if (fbxAnimations.length > 0) {
                  const mixer = new AnimationMixer(object);
                  mixers.push(mixer);
                  mixer.clipAction(fbxAnimations[0]).play();
                  console.log(`[AnimationMixer] ${target.label} playing: ${fbxAnimations[0].name}`);
                } else {
                  console.log(`[AnimationMixer] ${target.label}: No animations found`);
                }
              }

              objectRegistry.set(target.resourceId, object);
              loadedObjects.push(object);
              anchorRegistry.get(target.resourceId)?.add(object);
            })
          );
        } finally {
          console.warn = originalConsoleWarn;
        }

        if (disposed) {
          return;
        }

        const collectedAnimationInfo: AnimationInfo[] = [];
        referenceLibrary.targets.forEach((target) => {
          if (target.objectType === "fbx") {
            const object = objectRegistry.get(target.resourceId);
            const getAllAnimations = (animatedObject: Object3D): string[] => {
              const clips: string[] = [];
              if (animatedObject.animations && animatedObject.animations.length > 0) {
                animatedObject.animations.forEach((clip) => {
                  clips.push(clip.name || "unnamed");
                });
              }
              animatedObject.children.forEach((child) => {
                clips.push(...getAllAnimations(child));
              });
              return clips;
            };

            if (object) {
              const allClipNames = getAllAnimations(object);
              console.log(`[AnimationCheck] ${target.label}: root=${object.animations?.length || 0}, total=${allClipNames.length}`, allClipNames);

              collectedAnimationInfo.push({
                resourceId: target.resourceId,
                label: target.label,
                clipNames: allClipNames.length > 0 ? allClipNames : [],
              });
            } else {
              collectedAnimationInfo.push({
                resourceId: target.resourceId,
                label: target.label,
                clipNames: [],
              });
            }
          }
        });
        if (disposed) {
          return;
        }

        setAnimationInfo(collectedAnimationInfo);
        resourcesReady = true;
        setIsLoading(false);
        setStatusText(pendingTargetStatusText);

        if (container && onQRDetected) {
          const scheduleQrStartup = (delayMs: number) => {
            if (disposed || qrDetected) {
              return;
            }

            if (qrStartupTimeoutId !== null) {
              window.clearTimeout(qrStartupTimeoutId);
            }

            qrStartupTimeoutId = window.setTimeout(() => {
              qrStartupTimeoutId = null;
              void startQrScanner().catch(reportQrFailure);
            }, delayMs);
          };

          const startQrScanner = async () => {
            if (disposed || qrDetected || qrDecoderControls) {
              return;
            }

            const existingVideo = container.querySelector("video");
            if (!existingVideo || !existingVideo.srcObject) {
              scheduleQrStartup(500);
              return;
            }

            const onDetected = onQRDetected;
            const { BrowserQRCodeReader } = await import("@zxing/browser");
            if (disposed) {
              return;
            }

            const reader = new BrowserQRCodeReader();
            const controls = await reader.decodeFromVideoElement(existingVideo, (result, error, scanControls) => {
              if (disposed || qrDetected) {
                return;
              }

              if (!result) {
                const errorKind = error?.getKind();
                if (
                  error &&
                  errorKind !== "NotFoundException" &&
                  errorKind !== "ChecksumException" &&
                  errorKind !== "FormatException"
                ) {
                  qrDecoderControls = scanControls;
                  stopQrDecoder();
                  reportQrFailure(error);
                }
                return;
              }

              qrDetected = true;
              qrDecoderControls = scanControls;
              stopQrDecoder();
              const decodedText = result.getText();
              setQrDetectedText(decodedText);

              try {
                onDetected(decodedText);
              } catch (error) {
                reportQrFailure(error);
              }
            });

            if (disposed || qrDetected) {
              controls.stop();
              return;
            }

            qrDecoderControls = controls;
          };

          scheduleQrStartup(2000);
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        console.error("[AR] Image Target AR startup failed:", error);
        setIsLoading(false);
        setErrorText("Image Target AR 시작에 실패했습니다. 카메라 권한 또는 디바이스 호환성을 확인해주세요.");
      }
    };

    void boot();

    return () => {
      disposed = true;
      sceneRef.current = null;
      clearAllPendingLoss();
      clearPendingSwitch();
      detachResizeListener?.();
      detachResizeListener = null;
      detachPointerListener?.();
      detachPointerListener = null;

      if (qrStartupTimeoutId !== null) {
        window.clearTimeout(qrStartupTimeoutId);
        qrStartupTimeoutId = null;
      }
      stopQrDecoder();

      if (!mindar) {
        return;
      }

      mindar.renderer.setAnimationLoop(null);
      void Promise.resolve(mindar.stop()).catch((error: unknown) => {
        console.error("[AR] Failed to stop MindAR:", error);
      });
      mindar.renderer.dispose();

      loadedObjects.forEach((object) => {
        disposeObject3D(object);
      });

      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, []);

  return (
    <section className="relative h-full w-full bg-black">
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />

      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.6)_0%,rgba(0,0,0,0.15)_45%,rgba(0,0,0,0.62)_100%)]" />

      {isLoading && (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 text-white"
        >
          <span
            aria-hidden="true"
            className="h-9 w-9 animate-spin rounded-full border-4 border-white/30 border-t-cyan-300"
          />
          <p>AR 리소스를 불러오는 중입니다. 준비가 끝나면 타겟을 비춰주세요.</p>
        </div>
      )}

      {cubeVideoSrc && (
        <div className="absolute inset-0 z-40 bg-black/80 backdrop-blur-sm">
          <button
            type="button"
            onClick={() => setCubeVideoSrc("")}
            className="absolute right-4 top-4 z-50 rounded-full bg-black/60 px-3 py-2 text-xs font-bold tracking-wide text-white"
          >
            닫기
          </button>
          <div className="flex h-full w-full items-center justify-center p-4">
            <video
              src={cubeVideoSrc}
              autoPlay
              controls
              muted
              playsInline
              aria-label="큐브 면 비디오"
              className="max-h-full max-w-full rounded-lg"
            />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onExitToMap}
        className="absolute left-4 top-4 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white shadow-lg backdrop-blur active:opacity-80"
      >
        ←
      </button>

      <button
        type="button"
        onClick={() => setObjectsVisible((previous) => !previous)}
        aria-pressed={objectsVisible}
        aria-label={objectsVisible ? "AR 객체 숨기기" : "AR 객체 보이기"}
        className="absolute right-4 top-4 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white shadow-lg backdrop-blur active:opacity-80"
      >
        {objectsVisible ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
      </button>

      <div className="absolute bottom-4 left-1/2 z-30 w-[min(92%,760px)] -translate-x-1/2 rounded-2xl border border-white/20 bg-black/45 px-4 py-3 text-xs text-white backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-cyan-200">
            IMAGE TARGET AR{" "}
            <span className="font-normal text-white/40">
              {process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev"}
            </span>
          </p>
          <button
            type="button"
            onClick={() => setIsInfoPanelCollapsed((previous) => !previous)}
            aria-expanded={!isInfoPanelCollapsed}
            aria-label={isInfoPanelCollapsed ? "AR 정보 패널 펼치기" : "AR 정보 패널 접기"}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white active:opacity-80"
          >
            {isInfoPanelCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
        {!isInfoPanelCollapsed && (
          <>
            <p className="mt-1 text-white/90">{statusText}</p>
            {activeTarget && <p className="mt-1 text-emerald-300">활성 타겟: {activeTarget}</p>}
            {activeResourceKey && (
              <p className="mt-1 text-sky-300">배치: {describeImageMapping(activeResourceKey)}</p>
            )}
            {activeResourceKey && storySizes[activeResourceKey] && (
              <p className="mt-1 text-sky-300">크기: {storySizes[activeResourceKey]}</p>
            )}
            {qrDetectedText && (
              <p className="mt-1 text-yellow-300">QR 인식됨: {qrDetectedText}</p>
            )}
            {errorText && <p className="mt-1 text-rose-300">{errorText}</p>}
            {animationInfo.length > 0 && (
              <div className="mt-2 pt-2 border-t border-white/20">
                <p className="font-semibold text-yellow-300">Animations:</p>
                {animationInfo.map((info) => (
                  <p key={info.resourceId} className="mt-1 text-white/70">
                    {info.label}: {info.clipNames.length > 0 ? info.clipNames.join(", ") : "NONE"}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
