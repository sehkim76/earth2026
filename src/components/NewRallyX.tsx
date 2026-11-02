"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as THREE from "three";

import { checkEventEntry, readGameSearchParams } from "@/lib/game-score";

type Direction = "up" | "down" | "left" | "right";

interface Enemy {
  mesh: THREE.Group;
  direction: Direction;
  speed: number;
}

interface MapBlock {
  type: "road_h" | "road_v" | "intersection" | "turn_left" | "turn_right" | "building";
  x: number;
  z: number;
}

export default function NewRallyX() {
  const router = useRouter();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);

  const [score, setScore] = useState(0);
  const [fuel, setFuel] = useState(100);
  const [timeLeft, setTimeLeft] = useState(-1);
  const [isEndVisible, setIsEndVisible] = useState(false);
  const [isTimeOver, setIsTimeOver] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [entryChecked, setEntryChecked] = useState(false);

  const moveRef = useRef<(direction: Direction) => void>(() => {});
  const retryRef = useRef<() => void>(() => {});
  const isEndVisibleRef = useRef(false);
  const isTimeOverRef = useRef(false);

  const playerRef = useRef({ x: 0, z: 0, direction: "up" as Direction });
  const enemiesRef = useRef<Enemy[]>([]);
  const flagsRef = useRef<{ x: number; z: number; collected: boolean }[]>([]);
  const targetCameraDir = useRef<Direction>("up");

  useEffect(() => {
    isEndVisibleRef.current = isEndVisible;
    isTimeOverRef.current = isTimeOver;
  }, [isEndVisible, isTimeOver]);

  const onRetry = useCallback(() => {
    if (needsLogin) {
      return;
    }
    retryRef.current();
    setScore(0);
    setFuel(100);
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
    if (isEndVisibleRef.current || needsLogin) return;

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev > 0 && prev <= 1) {
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

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const tileSize = 50;
    const mapSize = 15;
    const boardWidth = tileSize * mapSize;

    const camera = new THREE.PerspectiveCamera(50, (window.innerWidth) / window.innerHeight, 0.1, 2000);
    const initialZ = (mapSize / 2 - 3 - 0.5) * tileSize;
    camera.position.set(0, 360, initialZ + 300);
    camera.lookAt(0, 10, initialZ);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    mountRef.current.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(200, 500, 200);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.left = -500;
    dirLight.shadow.camera.right = 500;
    dirLight.shadow.camera.top = 500;
    dirLight.shadow.camera.bottom = -500;
    scene.add(dirLight);

    const mapBlocks: MapBlock[] = [];
    const blockTypes: MapBlock["type"][] = ["road_h", "road_v", "intersection", "turn_left", "turn_right"];

    for (let row = 0; row < mapSize; row++) {
      for (let col = 0; col < mapSize; col++) {
        const x = (col - mapSize / 2) * tileSize + tileSize / 2;
        const z = (row - mapSize / 2) * tileSize + tileSize / 2;

        const isEdge = row === 0 || row === mapSize - 1 || col === 0 || col === mapSize - 1;
        const isRoadRow = row === 3 || row === 7 || row === 11;
        const isRoadCol = col === 3 || col === 7 || col === 11;
        const isIntersection = isRoadRow && isRoadCol;

        let type: MapBlock["type"];
        if (isEdge) {
          type = "building";
        } else if (isIntersection) {
          type = "intersection";
        } else if (isRoadRow) {
          type = "road_h";
        } else if (isRoadCol) {
          type = "road_v";
        } else {
          const rand = Math.random();
          if (rand < 0.15) {
            type = "turn_left";
          } else if (rand < 0.3) {
            type = "turn_right";
          } else {
            type = "building";
          }
        }

        mapBlocks.push({ type, x, z });

        if (type === "building") {
          const buildingGeometry = new THREE.BoxGeometry(tileSize * 0.9, tileSize * 0.6, tileSize * 0.9);
          const buildingMaterial = new THREE.MeshLambertMaterial({
            color: Math.random() > 0.5 ? 0x4a5568 : 0x2d3748,
          });
          const building = new THREE.Mesh(buildingGeometry, buildingMaterial);
          building.position.set(x, tileSize * 0.3, z);
          building.castShadow = true;
          building.receiveShadow = true;
          scene.add(building);
        } else {
          const roadGeometry = new THREE.PlaneGeometry(tileSize, tileSize);
          const roadMaterial = new THREE.MeshLambertMaterial({ color: 0x374151 });
          const road = new THREE.Mesh(roadGeometry, roadMaterial);
          road.rotation.x = -Math.PI / 2;
          road.position.set(x, 0.1, z);
          road.receiveShadow = true;
          scene.add(road);

          if (type === "road_h" || type === "road_v" || type === "intersection") {
            const lineGeometry = new THREE.PlaneGeometry(tileSize * 0.6, 2);
            const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xfde047 });
            const line = new THREE.Mesh(lineGeometry, lineMaterial);
            line.rotation.x = -Math.PI / 2;
            if (type === "road_h") {
              line.position.set(x, 0.2, z);
            } else {
              line.rotation.z = Math.PI / 2;
              line.position.set(x, 0.2, z);
            }
            scene.add(line);
          }
        }
      }
    }

    function createCar(color: number, isPlayer = false): THREE.Group {
      const car = new THREE.Group();

      const bodyGeometry = new THREE.BoxGeometry(24, 10, 14);
      const bodyMaterial = new THREE.MeshPhongMaterial({ color, flatShading: true });
      const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
      body.position.y = 5;
      body.castShadow = true;
      car.add(body);

      const cabinGeometry = new THREE.BoxGeometry(14, 6, 12);
      const cabinMaterial = new THREE.MeshPhongMaterial({ color: 0x222222, flatShading: true });
      const cabin = new THREE.Mesh(cabinGeometry, cabinMaterial);
      cabin.position.y = 12;
      cabin.position.x = -2;
      cabin.castShadow = true;
      car.add(cabin);

      if (isPlayer) {
        const roofLightGeometry = new THREE.BoxGeometry(4, 2, 4);
        const roofLightMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });
        const roofLight = new THREE.Mesh(roofLightGeometry, roofLightMaterial);
        roofLight.position.y = 16;
        car.add(roofLight);
      }

      const wheelGeometry = new THREE.CylinderGeometry(3, 3, 2, 8);
      const wheelMaterial = new THREE.MeshLambertMaterial({ color: 0x111111 });
      const wheelPositions = [
        { x: 8, z: 7 },
        { x: 8, z: -7 },
        { x: -8, z: 7 },
        { x: -8, z: -7 },
      ];
      wheelPositions.forEach((pos) => {
        const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(pos.x, 3, pos.z);
        car.add(wheel);
      });

      car.rotation.y = -Math.PI / 2;

      return car;
    }

    function createFlag(): THREE.Group {
      const flag = new THREE.Group();

      const poleGeometry = new THREE.CylinderGeometry(1, 1, 16, 8);
      const poleMaterial = new THREE.MeshLambertMaterial({ color: 0x888888 });
      const pole = new THREE.Mesh(poleGeometry, poleMaterial);
      pole.position.y = 8;
      flag.add(pole);

      const flagGeometry = new THREE.BoxGeometry(10, 6, 1);
      const flagMaterial = new THREE.MeshLambertMaterial({ color: 0xffd700 });
      const flagMesh = new THREE.Mesh(flagGeometry, flagMaterial);
      flagMesh.position.set(5, 14, 0);
      flag.add(flagMesh);

      return flag;
    }

    const playerCar = createCar(0xff4444, true);
    playerCar.position.set(0, 0, (mapSize / 2 - 3 - 0.5) * tileSize);
    playerCar.rotation.y = Math.PI / 2;
    scene.add(playerCar);
    playerRef.current = { x: 0, z: (mapSize / 2 - 3 - 0.5) * tileSize, direction: "down" };

    const enemyCars: Enemy[] = [];
    const enemySpawnPoints = [
      { x: -7 * tileSize, z: 3 * tileSize, dir: "right" as Direction, speed: 3 },
      { x: 7 * tileSize, z: 3 * tileSize, dir: "left" as Direction, speed: 2.5 },
      { x: -7 * tileSize, z: 7 * tileSize, dir: "right" as Direction, speed: 2 },
      { x: 7 * tileSize, z: 7 * tileSize, dir: "left" as Direction, speed: 2.8 },
      { x: -7 * tileSize, z: 11 * tileSize, dir: "right" as Direction, speed: 3.5 },
      { x: 7 * tileSize, z: 11 * tileSize, dir: "left" as Direction, speed: 3 },
      { x: 3 * tileSize, z: -7 * tileSize, dir: "up" as Direction, speed: 2.5 },
      { x: 7 * tileSize, z: -7 * tileSize, dir: "up" as Direction, speed: 3 },
      { x: 11 * tileSize, z: -7 * tileSize, dir: "up" as Direction, speed: 2.8 },
    ];

    enemySpawnPoints.forEach((spawn) => {
      const car = createCar(Math.random() > 0.5 ? 0x4488ff : 0xff8844);
      car.position.set(spawn.x + tileSize / 2, 0, spawn.z + tileSize / 2);
      if (spawn.dir === "left") car.rotation.y = Math.PI;
      if (spawn.dir === "down") car.rotation.y = Math.PI;
      scene.add(car);
      enemyCars.push({ mesh: car, direction: spawn.dir, speed: spawn.speed });
    });
    enemiesRef.current = enemyCars;

    const flags: { x: number; z: number; collected: boolean; mesh: THREE.Group }[] = [];
    const flagPositions = [
      { x: -7 * tileSize, z: 7 * tileSize },
      { x: 7 * tileSize, z: 11 * tileSize },
      { x: -3 * tileSize, z: -3 * tileSize },
      { x: 3 * tileSize, z: 3 * tileSize },
      { x: 11 * tileSize, z: -7 * tileSize },
    ];

    flagPositions.forEach((pos) => {
      const flag = createFlag();
      flag.position.set(pos.x + tileSize / 2, 0, pos.z + tileSize / 2);
      scene.add(flag);
      flags.push({ x: pos.x + tileSize / 2, z: pos.z + tileSize / 2, collected: false, mesh: flag });
    });
    flagsRef.current = flags;

    const setPlayerDirection = (direction: Direction) => {
      if (isEndVisibleRef.current || isTimeOverRef.current) return;

      const current = playerRef.current;
      playerRef.current = { ...current, direction };

      const currentCol = Math.floor((playerCar.position.x + boardWidth / 2) / tileSize);
      const currentRow = Math.floor((playerCar.position.z + boardWidth / 2) / tileSize);
      const centerX = (currentCol - mapSize / 2 + 0.5) * tileSize;
      const centerZ = (currentRow - mapSize / 2 + 0.5) * tileSize;
      playerCar.position.x = centerX;
      playerCar.position.z = centerZ;
      playerRef.current.x = centerX;
      playerRef.current.z = centerZ;

      if (direction === "left") playerCar.rotation.y = Math.PI;
      else if (direction === "right") playerCar.rotation.y = 0;
      else if (direction === "up") playerCar.rotation.y = -Math.PI / 2;
      else if (direction === "down") playerCar.rotation.y = Math.PI / 2;
    };

    moveRef.current = setPlayerDirection;

    retryRef.current = () => {
      playerRef.current = { x: 0, z: (mapSize / 2 - 3 - 0.5) * tileSize, direction: "down" };
      playerCar.position.set(0, 0, (mapSize / 2 - 3 - 0.5) * tileSize);
      playerCar.rotation.y = Math.PI / 2;
      targetCameraDir.current = "down";

      enemySpawnPoints.forEach((spawn, i) => {
        enemyCars[i].mesh.position.set(spawn.x + tileSize / 2, 0, spawn.z + tileSize / 2);
        enemyCars[i].direction = spawn.dir;
        if (spawn.dir === "left") enemyCars[i].mesh.rotation.y = Math.PI;
        else if (spawn.dir === "down") enemyCars[i].mesh.rotation.y = Math.PI;
        else enemyCars[i].mesh.rotation.y = 0;
      });

      flags.forEach((flag) => {
        flag.collected = false;
        flag.mesh.visible = true;
      });

      setScore(0);
      setFuel(100);
    };

    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp") {
        setPlayerDirection("up");
        targetCameraDir.current = "up";
      } else if (event.key === "ArrowDown") {
        setPlayerDirection("down");
        targetCameraDir.current = "down";
      } else if (event.key === "ArrowLeft") {
        setPlayerDirection("left");
        targetCameraDir.current = "left";
      } else if (event.key === "ArrowRight") {
        setPlayerDirection("right");
        targetCameraDir.current = "right";
      }
    };
    window.addEventListener("keydown", keyHandler);

    const resizeHandler = () => {
      camera.aspect = (window.innerWidth) / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", resizeHandler);

    const animate = (timestamp: number) => {
      requestAnimationFrame(animate);

      const delta = 16;
      const playerSpeed = 3;

      const playerMoveAmount = (playerSpeed / 16) * delta;
      let playerNewX = playerCar.position.x;
      let playerNewZ = playerCar.position.z;
      const moveDir = playerRef.current.direction;

      if (moveDir === "right") playerNewX += playerMoveAmount;
      else if (moveDir === "left") playerNewX -= playerMoveAmount;
      else if (moveDir === "up") playerNewZ -= playerMoveAmount;
      else if (moveDir === "down") playerNewZ += playerMoveAmount;

      const bound = (mapSize / 2 - 1) * tileSize;
      const col = Math.floor((playerNewX + boardWidth / 2) / tileSize);
      const row = Math.floor((playerNewZ + boardWidth / 2) / tileSize);

      const block = mapBlocks.find((b) => {
        const bCol = Math.floor((b.x + boardWidth / 2) / tileSize);
        const bRow = Math.floor((b.z + boardWidth / 2) / tileSize);
        return bCol === col && bRow === row;
      });

      const canMove = block && block.type !== "building" && Math.abs(playerNewX) <= bound && Math.abs(playerNewZ) <= bound;

      if (canMove) {
        playerCar.position.x = playerNewX;
        playerCar.position.z = playerNewZ;
        playerRef.current.x = playerNewX;
        playerRef.current.z = playerNewZ;

        setFuel((prev) => Math.max(0, prev - 0.1));

        flags.forEach((flag) => {
          if (!flag.collected) {
            const dx = Math.abs(playerNewX - flag.x);
            const dz = Math.abs(playerNewZ - flag.z);
            if (dx < tileSize / 2 && dz < tileSize / 2) {
              flag.collected = true;
              flag.mesh.visible = false;
              setScore((prev) => prev + 100);
            }
          }
        });
      } else {
        const currentDir = playerRef.current.direction;
        let newDir: Direction = currentDir;

        const turnRight: Record<Direction, Direction> = {
          up: "right",
          right: "down",
          down: "left",
          left: "up",
        };

        const turnLeft: Record<Direction, Direction> = {
          up: "left",
          left: "down",
          down: "right",
          right: "up",
        };

        const checkDir = (dir: Direction): boolean => {
          let checkX = playerCar.position.x;
          let checkZ = playerCar.position.z;
          if (dir === "right") checkX += tileSize;
          else if (dir === "left") checkX -= tileSize;
          else if (dir === "up") checkZ -= tileSize;
          else if (dir === "down") checkZ += tileSize;

          const checkCol = Math.floor((checkX + boardWidth / 2) / tileSize);
          const checkRow = Math.floor((checkZ + boardWidth / 2) / tileSize);
          const checkBlock = mapBlocks.find((b) => {
            const bCol = Math.floor((b.x + boardWidth / 2) / tileSize);
            const bRow = Math.floor((b.z + boardWidth / 2) / tileSize);
            return bCol === checkCol && bRow === checkRow;
          });
          return checkBlock !== undefined && checkBlock.type !== "building" && Math.abs(checkX) <= bound && Math.abs(checkZ) <= bound;
        };

        const rightDir = turnRight[currentDir];
        if (checkDir(rightDir)) {
          newDir = rightDir;
        } else {
          const leftDir = turnLeft[currentDir];
          if (checkDir(leftDir)) {
            newDir = leftDir;
          } else {
            const turnAround: Record<Direction, Direction> = {
              up: "down",
              down: "up",
              left: "right",
              right: "left",
            };
            const backDir = turnAround[currentDir];
            if (checkDir(backDir)) {
              newDir = backDir;
            }
          }
        }

        if (newDir !== currentDir) {
          playerRef.current.direction = newDir;
          if (newDir === "left") playerCar.rotation.y = Math.PI;
          else if (newDir === "right") playerCar.rotation.y = 0;
          else if (newDir === "up") playerCar.rotation.y = -Math.PI / 2;
          else if (newDir === "down") playerCar.rotation.y = Math.PI / 2;
          targetCameraDir.current = newDir;
        }
      }

      enemyCars.forEach((enemy) => {
        const speed = enemy.speed;
        const moveAmount = (speed / 16) * delta;

        let newX = enemy.mesh.position.x;
        let newZ = enemy.mesh.position.z;

        if (enemy.direction === "right") newX += moveAmount;
        else if (enemy.direction === "left") newX -= moveAmount;
        else if (enemy.direction === "up") newZ -= moveAmount;
        else if (enemy.direction === "down") newZ += moveAmount;

        const bound = (mapSize / 2 - 1) * tileSize;

        if (Math.abs(newX) > bound || Math.abs(newZ) > bound) {
          if (enemy.direction === "right") enemy.direction = "left";
          else if (enemy.direction === "left") enemy.direction = "right";
          else if (enemy.direction === "up") enemy.direction = "down";
          else if (enemy.direction === "down") enemy.direction = "up";
          enemy.mesh.rotation.y = enemy.direction === "left" ? Math.PI : enemy.direction === "down" ? Math.PI : 0;
        } else {
          enemy.mesh.position.x = newX;
          enemy.mesh.position.z = newZ;
        }
      });

      const playerBox = {
        minX: playerCar.position.x - 12,
        maxX: playerCar.position.x + 12,
        minZ: playerCar.position.z - 7,
        maxZ: playerCar.position.z + 7,
      };

      enemyCars.forEach((enemy) => {
        const enemyBox = {
          minX: enemy.mesh.position.x - 12,
          maxX: enemy.mesh.position.x + 12,
          minZ: enemy.mesh.position.z - 7,
          maxZ: enemy.mesh.position.z + 7,
        };

        if (
          playerBox.minX < enemyBox.maxX &&
          playerBox.maxX > enemyBox.minX &&
          playerBox.minZ < enemyBox.maxZ &&
          playerBox.maxZ > enemyBox.minZ
        ) {
          setIsEndVisible(true);
        }
      });

      const cameraHeight = 360;
      const cameraDistance = 300;
      const smoothSpeed = 0.1;

      const getTargetCameraPos = (dir: Direction) => {
        const baseX = playerCar.position.x;
        const baseZ = playerCar.position.z;
        if (dir === "up") return { x: baseX, z: baseZ + cameraDistance };
        if (dir === "down") return { x: baseX, z: baseZ - cameraDistance };
        if (dir === "left") return { x: baseX + cameraDistance, z: baseZ };
        if (dir === "right") return { x: baseX - cameraDistance, z: baseZ };
        return { x: baseX, z: baseZ + cameraDistance };
      };

      const targetPos = getTargetCameraPos(targetCameraDir.current);
      camera.position.x += (targetPos.x - camera.position.x) * smoothSpeed;
      camera.position.z += (targetPos.z - camera.position.z) * smoothSpeed;
      camera.position.y = cameraHeight;
      camera.lookAt(playerCar.position.x, 10, playerCar.position.z);

      renderer.render(scene, camera);

      drawMinimap();
    };

    const drawMinimap = () => {
      const canvas = minimapRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const size = 90;
      const scale = size / boardWidth;
      const offset = size / 2;

      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, size, size);

      mapBlocks.forEach((block) => {
        const x = block.x * scale + offset;
        const y = block.z * scale + offset;
        const tileScale = tileSize * scale;

        if (block.type === "building") {
          ctx.fillStyle = "#4a5568";
        } else {
          ctx.fillStyle = "#374151";
        }
        ctx.fillRect(x - tileScale / 2, y - tileScale / 2, tileScale - 0.5, tileScale - 0.5);
      });

      flagsRef.current.forEach((flag) => {
        if (!flag.collected) {
          const x = flag.x * scale + offset;
          const y = flag.z * scale + offset;
          ctx.fillStyle = "#ffd700";
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      ctx.fillStyle = "#4488ff";
      enemiesRef.current.forEach((enemy) => {
        const x = enemy.mesh.position.x * scale + offset;
        const y = enemy.mesh.position.z * scale + offset;
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.fillStyle = "#ff4444";
      const px = playerRef.current.x * scale + offset;
      const pz = playerRef.current.z * scale + offset;
      ctx.beginPath();
      ctx.arc(px, pz, 4, 0, Math.PI * 2);
      ctx.fill();
    };

    animate(0);

    return () => {
      window.removeEventListener("keydown", keyHandler);
      window.removeEventListener("resize", resizeHandler);
      renderer.dispose();
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, [entryChecked]);

  if (!entryChecked) {
    return (
      <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-[#0f0f1a] p-6" aria-live="polite" aria-busy="true">
        <p className="text-sm font-black tracking-wide text-white/80">확인 중…</p>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-[#0f0f1a] p-6">
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
    <div className="relative w-screen h-screen overflow-hidden bg-[#0f0f1a]">
      <div ref={mountRef} className="w-full h-full" />

      <div className="absolute top-0 right-0 w-[180px] bg-orange-300/30 p-0.5 flex flex-col rounded-bl-xl">
        <div className="flex flex-row flex-wrap gap-y-2 justify-between">
          <div className="flex flex-col gap-0 min-w-[50px]">
            <span className="text-[#94a3b8] text-[6px]">TIME</span>
            <span className="text-white text-xs">{timeLeft}</span>
          </div>
          <div className="flex flex-col gap-0 min-w-[50px]">
            <span className="text-[#94a3b8] text-[6px]">SCORE</span>
            <span className="text-white text-xs">{score}</span>
          </div>
          <div className="flex flex-col gap-0 w-full mb-2">
            <span className="text-[#94a3b8] text-[6px]">FUEL</span>
            <div className="w-full h-1 bg-[#374151] rounded-sm overflow-hidden">
              <div className="h-full bg-gradient-to-r from-red-500 via-amber-500 to-green-500 transition-all duration-300" style={{ width: `${fuel}%` }} />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center">
          <canvas ref={minimapRef} width={90} height={90} className="border border-[#4a5568] rounded bg-[#1a1a2e]" />
        </div>
      </div>

      <div className={`absolute inset-0 flex items-center justify-center ${isEndVisible ? "visible" : "invisible"} bg-black/80`}>
        <div className="bg-white px-8 py-6 rounded-xl text-center">
          <h2 className="text-xl mb-4 text-gray-800">{isTimeOver ? "Time Over!" : "Game Over!"}</h2>
          <p className="text-lg mb-6 text-gray-600">Score: {score}</p>
          <button onClick={onRetry} className="bg-green-500 px-8 py-3 text-white rounded-lg font-press">OK</button>
        </div>
      </div>
    </div>
  );
}
