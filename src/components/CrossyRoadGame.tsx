"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as THREE from "three";

import { checkEventEntry, readGameSearchParams } from "@/lib/game-score";

/**
 * React 변환 버전 요약
 * - script.js 로직을 useEffect에 담음
 * - DOM counter/end visibility -> React state로 제어
 * - 버튼 클릭/키보드 입력 -> move(direction)
 */
type MoveDir = "forward" | "backward" | "left" | "right";

export default function CrossyRoadGame() {
  const router = useRouter();
  const mountRef = useRef<HTMLDivElement | null>(null);

  // UI state
  const [counter, setCounter] = useState(0);
  const [isEndVisible, setIsEndVisible] = useState(false);
  const [timeLeft, setTimeLeft] = useState(60);
  const [isTimeOver, setIsTimeOver] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [entryChecked, setEntryChecked] = useState(false);

  // Three / game refs (렌더링 루프에서도 안정적으로 접근하려고 useRef 사용)
  const moveRef = useRef<(direction: MoveDir) => void>(() => {});
  const retryRef = useRef<() => void>(() => {});
  const isEndVisibleRef = useRef(false);
  const isTimeOverRef = useRef(false);

  useEffect(() => {
    isEndVisibleRef.current = isEndVisible;
    isTimeOverRef.current = isTimeOver;
  }, [isEndVisible, isTimeOver]);

  const onMove = useCallback(
    (dir: MoveDir) => {
      if (needsLogin) {
        return;
      }
      moveRef.current(dir);
    },
    [needsLogin],
  );
  const onRetry = useCallback(() => {
    if (needsLogin) {
      return;
    }
    retryRef.current();
    setTimeLeft(60);
    setIsEndVisible(false);
    setIsTimeOver(false);
  }, [needsLogin]);

  useEffect(() => {
    const { eventKey } = readGameSearchParams();
    if (!eventKey) {
      setEntryChecked(true);
      return;
    }
    let cancelled = false;
    void checkEventEntry(eventKey)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result === "login") {
          setNeedsLogin(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEntryChecked(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!entryChecked || isEndVisibleRef.current || needsLogin) return;

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          setIsTimeOver(true);
          setIsEndVisible(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [entryChecked, needsLogin]);

  useEffect(() => {
    if (!entryChecked || !mountRef.current) return;

    // =========================
    // Variables from script.js
    // =========================
    const scene = new THREE.Scene();

    const distance = 500;
    const camera = new THREE.OrthographicCamera(
      window.innerWidth / -2,
      window.innerWidth / 2,
      window.innerHeight / 2,
      window.innerHeight / -2,
      0.1,
      10000
    );

    camera.rotation.x = (50 * Math.PI) / 180;
    camera.rotation.y = (20 * Math.PI) / 180;
    camera.rotation.z = (10 * Math.PI) / 180;

    const initialCameraPositionY = -Math.tan(camera.rotation.x) * distance;
    const initialCameraPositionX =
      Math.tan(camera.rotation.y) * Math.sqrt(distance ** 2 + initialCameraPositionY ** 2);

    camera.position.y = initialCameraPositionY;
    camera.position.x = initialCameraPositionX;
    camera.position.z = distance;

    const zoom = 2;
    const chickenSize = 15;
    const positionWidth = 42;
    const columns = 17;
    const boardWidth = positionWidth * columns;
    const stepTime = 200;

    // State (game loop)
    type LaneType = "field" | "forest" | "car" | "truck";
    type Lane = {
      index: number;
      type: LaneType;
      mesh: THREE.Object3D;
      occupiedPositions?: Set<number>;
      threes?: THREE.Object3D[];
      direction?: boolean;
      vechicles?: THREE.Object3D[];
      speed?: number;
    };
    let lanes: Lane[] = [];
    let currentLane = 0;
    let currentColumn = Math.floor(columns / 2);
    let previousTimestamp: number | null = null;
    let startMoving = false;
    let moves: MoveDir[] = [];
    let stepStartTimestamp: number | null = null;

    // Lights
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.6);
    scene.add(hemiLight);

    const initialDirLightPositionX = -100;
    const initialDirLightPositionY = -100;
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(initialDirLightPositionX, initialDirLightPositionY, 200);
    dirLight.castShadow = true;
    scene.add(dirLight);

    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    const d = 500;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;

    const backLight = new THREE.DirectionalLight(0x000000, 0.4);
    backLight.position.set(200, 200, 50);
    backLight.castShadow = true;
    scene.add(backLight);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setSize(window.innerWidth, window.innerHeight);

    mountRef.current.appendChild(renderer.domElement);

    // =========================
    // helper functions from script.js
    // =========================
    function Texture(width: number, height: number, rects: Array<{ x: number; y: number; w: number; h: number }>) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "rgba(0,0,0,0.6)";
      rects.forEach((rect) => context.fillRect(rect.x, rect.y, rect.w, rect.h));
      return new THREE.CanvasTexture(canvas);
    }

    const carFrontTexture = Texture(40, 80, [{ x: 0, y: 10, w: 30, h: 60 }]);
    const carBackTexture = Texture(40, 80, [{ x: 10, y: 10, w: 30, h: 60 }]);
    const carRightSideTexture = Texture(110, 40, [
      { x: 10, y: 0, w: 50, h: 30 },
      { x: 70, y: 0, w: 30, h: 30 },
    ]);
    const carLeftSideTexture = Texture(110, 40, [
      { x: 10, y: 10, w: 50, h: 30 },
      { x: 70, y: 10, w: 30, h: 30 },
    ]);

    const truckFrontTexture = Texture(30, 30, [{ x: 15, y: 0, w: 10, h: 30 }]);
    const truckRightSideTexture = Texture(25, 30, [{ x: 0, y: 15, w: 10, h: 10 }]);
    const truckLeftSideTexture = Texture(25, 30, [{ x: 0, y: 5, w: 10, h: 10 }]);

    const laneTypes = ["car", "truck", "forest"] as const;
    const laneSpeeds = [2, 2.5, 3];
    const vechicleColors = [0xa52523, 0xbdb638, 0x78b14b];
    const threeHeights = [20, 45, 60];

    function Wheel() {
      const wheel = new THREE.Mesh(
        new THREE.BoxGeometry(12 * zoom, 33 * zoom, 12 * zoom),
        new THREE.MeshLambertMaterial({ color: 0x333333, flatShading: true })
      );
      wheel.position.z = 6 * zoom;
      return wheel;
    }

    function Car() {
      const car = new THREE.Group();
      const color = vechicleColors[Math.floor(Math.random() * vechicleColors.length)];

      const main = new THREE.Mesh(
        new THREE.BoxGeometry(60 * zoom, 30 * zoom, 15 * zoom),
        new THREE.MeshPhongMaterial({ color, flatShading: true })
      );
      main.position.z = 12 * zoom;
      main.castShadow = true;
      main.receiveShadow = true;
      car.add(main);

      const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(33 * zoom, 24 * zoom, 12 * zoom),
        [
          new THREE.MeshPhongMaterial({ color: 0xcccccc, flatShading: true, map: carBackTexture }),
          new THREE.MeshPhongMaterial({ color: 0xcccccc, flatShading: true, map: carFrontTexture }),
          new THREE.MeshPhongMaterial({ color: 0xcccccc, flatShading: true, map: carRightSideTexture }),
          new THREE.MeshPhongMaterial({ color: 0xcccccc, flatShading: true, map: carLeftSideTexture }),
          new THREE.MeshPhongMaterial({ color: 0xcccccc, flatShading: true }),
          new THREE.MeshPhongMaterial({ color: 0xcccccc, flatShading: true }),
        ]
      );
      cabin.position.x = 6 * zoom;
      cabin.position.z = 25.5 * zoom;
      cabin.castShadow = true;
      cabin.receiveShadow = true;
      car.add(cabin);

      const frontWheel = Wheel();
      frontWheel.position.x = -18 * zoom;
      car.add(frontWheel);

      const backWheel = Wheel();
      backWheel.position.x = 18 * zoom;
      car.add(backWheel);

      car.castShadow = true;
      return car;
    }

    function Truck() {
      const truck = new THREE.Group();
      const color = vechicleColors[Math.floor(Math.random() * vechicleColors.length)];

      const base = new THREE.Mesh(
        new THREE.BoxGeometry(100 * zoom, 25 * zoom, 5 * zoom),
        new THREE.MeshLambertMaterial({ color: 0xb4c6fc, flatShading: true })
      );
      base.position.z = 10 * zoom;
      truck.add(base);

      const cargo = new THREE.Mesh(
        new THREE.BoxGeometry(75 * zoom, 35 * zoom, 40 * zoom),
        new THREE.MeshPhongMaterial({ color: 0xb4c6fc, flatShading: true })
      );
      cargo.position.x = 15 * zoom;
      cargo.position.z = 30 * zoom;
      cargo.castShadow = true;
      cargo.receiveShadow = true;
      truck.add(cargo);

      const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(25 * zoom, 30 * zoom, 30 * zoom),
        [
          new THREE.MeshPhongMaterial({ color, flatShading: true }),
          new THREE.MeshPhongMaterial({ color, flatShading: true, map: truckFrontTexture }),
          new THREE.MeshPhongMaterial({ color, flatShading: true, map: truckRightSideTexture }),
          new THREE.MeshPhongMaterial({ color, flatShading: true, map: truckLeftSideTexture }),
          new THREE.MeshPhongMaterial({ color, flatShading: true }),
          new THREE.MeshPhongMaterial({ color, flatShading: true }),
        ]
      );
      cabin.position.x = -40 * zoom;
      cabin.position.z = 20 * zoom;
      cabin.castShadow = true;
      cabin.receiveShadow = true;
      truck.add(cabin);

      const frontWheel = Wheel();
      frontWheel.position.x = -38 * zoom;
      truck.add(frontWheel);

      const middleWheel = Wheel();
      middleWheel.position.x = -10 * zoom;
      truck.add(middleWheel);

      const backWheel = Wheel();
      backWheel.position.x = 30 * zoom;
      truck.add(backWheel);

      return truck;
    }

    function ThreeTree() {
      const three = new THREE.Group();

      const trunk = new THREE.Mesh(
        new THREE.BoxGeometry(15 * zoom, 15 * zoom, 20 * zoom),
        new THREE.MeshPhongMaterial({ color: 0x4d2926, flatShading: true })
      );
      trunk.position.z = 10 * zoom;
      trunk.castShadow = true;
      trunk.receiveShadow = true;
      three.add(trunk);

      const height = threeHeights[Math.floor(Math.random() * threeHeights.length)];

      const crown = new THREE.Mesh(
        new THREE.BoxGeometry(30 * zoom, 30 * zoom, height * zoom),
        new THREE.MeshLambertMaterial({ color: 0x7aa21d, flatShading: true })
      );
      crown.position.z = (height / 2 + 20) * zoom;
      crown.castShadow = true;
      three.add(crown);

      return three;
    }

    function Chicken() {
      const chicken = new THREE.Group();

      const body = new THREE.Mesh(
        new THREE.BoxGeometry(chickenSize * zoom, chickenSize * zoom, 20 * zoom),
        new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true })
      );
      body.position.z = 10 * zoom;
      body.castShadow = true;
      body.receiveShadow = true;
      chicken.add(body);

      const rowel = new THREE.Mesh(
        new THREE.BoxGeometry(2 * zoom, 4 * zoom, 2 * zoom),
        new THREE.MeshLambertMaterial({ color: 0xf0619a, flatShading: true })
      );
      rowel.position.z = 21 * zoom;
      rowel.castShadow = true;
      chicken.add(rowel);

      return chicken;
    }

    function Road() {
      const road = new THREE.Group();
      const createSection = (color: number) =>
        new THREE.Mesh(
          new THREE.PlaneGeometry(boardWidth * zoom, positionWidth * zoom),
          new THREE.MeshPhongMaterial({ color })
        );

      const middle = createSection(0x454a59);
      middle.receiveShadow = true;
      road.add(middle);

      const left = createSection(0x393d49);
      left.position.x = -boardWidth * zoom;
      road.add(left);

      const right = createSection(0x393d49);
      right.position.x = boardWidth * zoom;
      road.add(right);

      return road;
    }

    function Grass() {
      const grass = new THREE.Group();
      const createSection = (color: number) =>
        new THREE.Mesh(
          new THREE.BoxGeometry(boardWidth * zoom, positionWidth * zoom, 3 * zoom),
          new THREE.MeshPhongMaterial({ color })
        );

      const middle = createSection(0xbaf455);
      middle.receiveShadow = true;
      grass.add(middle);

      const left = createSection(0x99c846);
      left.position.x = -boardWidth * zoom;
      grass.add(left);

      const right = createSection(0x99c846);
      right.position.x = boardWidth * zoom;
      grass.add(right);

      grass.position.z = 1.5 * zoom;
      return grass;
    }

    function createLane(index: number): Lane {
      const lane: Lane = {
        index,
        type: index <= 0 ? "field" : laneTypes[Math.floor(Math.random() * laneTypes.length)],
        mesh: null as unknown as THREE.Object3D,
      };

      switch (lane.type) {
        case "field": {
          lane.type = "field";
          lane.mesh = Grass();
          break;
        }
        case "forest": {
          lane.mesh = Grass();
          lane.occupiedPositions = new Set<number>();
          lane.threes = [1, 2, 3, 4].map(() => {
            const three = ThreeTree();
            let position: number;
            do {
              position = Math.floor(Math.random() * columns);
            } while (lane.occupiedPositions!.has(position));
            lane.occupiedPositions!.add(position);
            three.position.x = (position * positionWidth + positionWidth / 2) * zoom - (boardWidth * zoom) / 2;
            lane.mesh.add(three);
            return three;
          });
          break;
        }
        case "car": {
          lane.mesh = Road();
          lane.direction = Math.random() >= 0.5;
          const occupiedPositions = new Set<number>();
          lane.vechicles = [1, 2, 3].map(() => {
            const vechicle = Car();
            let position: number;
            do {
              position = Math.floor(Math.random() * (columns / 2));
            } while (occupiedPositions.has(position));
            occupiedPositions.add(position);
            vechicle.position.x = (position * positionWidth * 2 + positionWidth / 2) * zoom - (boardWidth * zoom) / 2;
            if (!lane.direction) vechicle.rotation.z = Math.PI;
            lane.mesh.add(vechicle);
            return vechicle;
          });
          lane.speed = laneSpeeds[Math.floor(Math.random() * laneSpeeds.length)];
          break;
        }
        case "truck": {
          lane.mesh = Road();
          lane.direction = Math.random() >= 0.5;
          const occupiedPositions = new Set<number>();
          lane.vechicles = [1, 2].map(() => {
            const vechicle = Truck();
            let position: number;
            do {
              position = Math.floor(Math.random() * (columns / 3));
            } while (occupiedPositions.has(position));
            occupiedPositions.add(position);
            vechicle.position.x = (position * positionWidth * 3 + positionWidth / 2) * zoom - (boardWidth * zoom) / 2;
            if (!lane.direction) vechicle.rotation.z = Math.PI;
            lane.mesh.add(vechicle);
            return vechicle;
          });
          lane.speed = laneSpeeds[Math.floor(Math.random() * laneSpeeds.length)];
          break;
        }
      }
      return lane;
    }

    const chicken = Chicken();
    scene.add(chicken);
    dirLight.target = chicken;

    const generateLanes = () =>
      [-9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map((index) => {
          const lane = createLane(index);
          lane.mesh.position.y = index * positionWidth * zoom;
          scene.add(lane.mesh);
          return lane;
        })
        .filter((lane) => lane.index >= 0);

    const addLane = () => {
      const index = lanes.length;
      const lane = createLane(index);
      lane.mesh.position.y = index * positionWidth * zoom;
      scene.add(lane.mesh);
      lanes.push(lane);
    };

    const initaliseValues = () => {
      lanes = generateLanes();
      currentLane = 0;
      currentColumn = Math.floor(columns / 2);

      previousTimestamp = null;
      startMoving = false;
      moves = [];
      stepStartTimestamp = null;

      chicken.position.x = 0;
      chicken.position.y = 0;

      camera.position.y = initialCameraPositionY;
      camera.position.x = initialCameraPositionX;

      dirLight.position.x = initialDirLightPositionX;
      dirLight.position.y = initialDirLightPositionY;

      setCounter(0);
      setIsEndVisible(false);
    };

    initaliseValues();

    // React handlers
    function move(direction: MoveDir) {
      if (isEndVisible) return; // 끝났으면 이동 금지

      const finalPositions = moves.reduce(
        (position, mv) => {
          if (mv === "forward") return { lane: position.lane + 1, column: position.column };
          if (mv === "backward") return { lane: position.lane - 1, column: position.column };
          if (mv === "left") return { lane: position.lane, column: position.column - 1 };
          if (mv === "right") return { lane: position.lane, column: position.column + 1 };
          return position;
        },
        { lane: currentLane, column: currentColumn }
      );

      if (direction === "forward") {
        if (
          lanes[finalPositions.lane + 1]?.type === "forest" &&
          lanes[finalPositions.lane + 1]?.occupiedPositions?.has(finalPositions.column)
        )
          return;
        if (!stepStartTimestamp) startMoving = true;
        addLane();
      } else if (direction === "backward") {
        if (finalPositions.lane === 0) return;
        if (lanes[finalPositions.lane - 1]?.type === "forest" && lanes[finalPositions.lane - 1]?.occupiedPositions?.has(finalPositions.column)) return;
        if (!stepStartTimestamp) startMoving = true;
      } else if (direction === "left") {
        if (finalPositions.column === 0) return;
        if (lanes[finalPositions.lane]?.type === "forest" && lanes[finalPositions.lane]?.occupiedPositions?.has(finalPositions.column - 1)) return;
        if (!stepStartTimestamp) startMoving = true;
      } else if (direction === "right") {
        if (finalPositions.column === columns - 1) return;
        if (lanes[finalPositions.lane]?.type === "forest" && lanes[finalPositions.lane]?.occupiedPositions?.has(finalPositions.column + 1)) return;
        if (!stepStartTimestamp) startMoving = true;
      }

      moves.push(direction);
    }

    moveRef.current = move;
    retryRef.current = () => {
      lanes.forEach((lane) => scene.remove(lane.mesh));
      initaliseValues();
    };

    // keyboard
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp") move("forward");
      else if (event.key === "ArrowDown") move("backward");
      else if (event.key === "ArrowLeft") move("left");
      else if (event.key === "ArrowRight") move("right");
    };
    window.addEventListener("keydown", keyHandler);

    // resize
    const resizeHandler = () => {
      camera.left = window.innerWidth / -2;
      camera.right = window.innerWidth / 2;
      camera.top = window.innerHeight / 2;
      camera.bottom = window.innerHeight / -2;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", resizeHandler);

    // animation loop
    let raf = 0;
    const animate = (timestamp: number) => {
      raf = requestAnimationFrame(animate);

      if (!previousTimestamp) previousTimestamp = timestamp;
      const delta = timestamp - previousTimestamp;
      previousTimestamp = timestamp;

      // move cars/trucks
      lanes.forEach((lane:Lane) => {
        if (lane.type === "car" || lane.type === "truck") {
          const aBitBefore = -(boardWidth * zoom) / 2 - positionWidth * 2 * zoom;
          const aBitAfter = (boardWidth * zoom) / 2 + positionWidth * 2 * zoom;
          if (lane.vechicles) {
            lane.vechicles.forEach((vechicle: THREE.Object3D) => {
              if (lane.direction) {

                vechicle.position.x = vechicle.position.x < aBitBefore ? aBitAfter : (vechicle.position.x -= (lane.speed! / 16) * delta);
              } else {

                vechicle.position.x = vechicle.position.x > aBitAfter ? aBitBefore : (vechicle.position.x += (lane.speed! / 16) * delta);
              }
            });
          }
        }
      });

      if (startMoving) {
        stepStartTimestamp = timestamp;
        startMoving = false;
      }

      if (stepStartTimestamp) {
        const moveDeltaTime = timestamp - stepStartTimestamp;
        const moveDeltaDistance = Math.min(moveDeltaTime / stepTime, 1) * positionWidth * zoom;
        const jumpDeltaDistance = Math.sin(Math.min(moveDeltaTime / stepTime, 1) * Math.PI) * 8 * zoom;

        switch (moves[0]) {
          case "forward": {
            const positionY = currentLane * positionWidth * zoom + moveDeltaDistance;
            camera.position.y = initialCameraPositionY + positionY;
            dirLight.position.y = initialDirLightPositionY + positionY;
            chicken.position.y = positionY;
            chicken.position.z = jumpDeltaDistance;
            break;
          }
          case "backward": {
            const positionY = currentLane * positionWidth * zoom - moveDeltaDistance;
            camera.position.y = initialCameraPositionY + positionY;
            dirLight.position.y = initialDirLightPositionY + positionY;
            chicken.position.y = positionY;
            chicken.position.z = jumpDeltaDistance;
            break;
          }
          case "left": {
            const positionX =
              (currentColumn * positionWidth + positionWidth / 2) * zoom -
              (boardWidth * zoom) / 2 -
              moveDeltaDistance;
            camera.position.x = initialCameraPositionX + positionX;
            dirLight.position.x = initialDirLightPositionX + positionX;
            chicken.position.x = positionX;
            chicken.position.z = jumpDeltaDistance;
            break;
          }
          case "right": {
            const positionX =
              (currentColumn * positionWidth + positionWidth / 2) * zoom -
              (boardWidth * zoom) / 2 +
              moveDeltaDistance;
            camera.position.x = initialCameraPositionX + positionX;
            dirLight.position.x = initialDirLightPositionX + positionX;
            chicken.position.x = positionX;
            chicken.position.z = jumpDeltaDistance;
            break;
          }
        }

        // step end
        if (moveDeltaTime > stepTime) {
          switch (moves[0]) {
            case "forward":
              currentLane++;
              setCounter(currentLane);
              break;
            case "backward":
              currentLane--;
              setCounter(currentLane);
              break;
            case "left":
              currentColumn--;
              break;
            case "right":
              currentColumn++;
              break;
          }
          moves.shift();
          stepStartTimestamp = moves.length === 0 ? null : timestamp;
        }
      }

      // hit test
      if (lanes[currentLane]?.type === "car" || lanes[currentLane]?.type === "truck") {
        const chickenMinX = chicken.position.x - (chickenSize * zoom) / 2;
        const chickenMaxX = chicken.position.x + (chickenSize * zoom) / 2;
        const vechicleLength =
          lanes[currentLane].type === "car"
            ? 60
            : lanes[currentLane].type === "truck"
            ? 105
            : 0;

        lanes[currentLane].vechicles?.forEach((vechicle: THREE.Object3D) => {
          const carMinX = vechicle.position.x - (vechicleLength * zoom) / 2;
          const carMaxX = vechicle.position.x + (vechicleLength * zoom) / 2;
          if (chickenMaxX > carMinX && chickenMinX < carMaxX) {
            setIsEndVisible(true);
          }
        });
      }

      renderer.render(scene, camera);
    };

    raf = requestAnimationFrame(animate);

    // cleanup
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", keyHandler);
      window.removeEventListener("resize", resizeHandler);

      // renderer dom remove
      renderer.dispose();
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, [entryChecked]);

  if (!entryChecked) {
    return (
      <div className="crossy-root flex items-center justify-center p-6" aria-live="polite" aria-busy="true">
        <p className="text-sm font-black tracking-wide text-white/80">확인 중…</p>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="crossy-root flex items-center justify-center p-6">
        <div
          role="alertdialog"
          aria-live="polite"
          className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl bg-white p-8 text-center shadow-2xl"
        >
          <p className="text-xl font-black tracking-tight text-slate-900">로그인이 필요합니다</p>
          <button
            type="button"
            onClick={() => {
              const { eventKey } = readGameSearchParams();
              router.push(
                `/?callbackUrl=${encodeURIComponent(`/event?eventkey=${encodeURIComponent(eventKey)}`)}`,
              );
            }}
            className="min-h-12 w-full rounded-xl bg-slate-900 px-8 py-3 text-base font-black tracking-wide text-white active:translate-y-0.5"
          >
            로그인하러 가기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="crossy-root">
      {/* Three.js mount */}
      <div ref={mountRef} className="canvasMount" />

      {/* Timer */}
      <div className="timer">{timeLeft}</div>

      {/* Counter */}
      <div className="counter">{counter}</div>

      {/* Controls */}
      <div className="controlls">
        <div className="grid">
          <button onClick={() => onMove("forward")} aria-label="forward">
            ▲
          </button>
          <button onClick={() => onMove("left")} aria-label="left">
            ◀
          </button>
          <button onClick={() => onMove("backward")} aria-label="backward">
            ▼
          </button>
          <button onClick={() => onMove("right")} aria-label="right">
            ▶
          </button>
        </div>
      </div>

      {/* End overlay */}
      <div className={`end ${isEndVisible ? "visible" : ""}`}>
        <div className="end-content">
          <h2>{isTimeOver ? "Time Over!" : "Game Over!"}</h2>
          <p>Score: {counter}</p>
          <button onClick={onRetry}>OK</button>
        </div>
      </div>
    </div>
  );
}
