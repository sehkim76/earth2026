import * as THREE from "three";
import gsap from "gsap";
import { Stage } from "./Stage";
import { Block } from "./Block";
import type {
  BlockSnapshot,
  BlockState,
  GameState,
  TowerSnapshot,
  BlockReturn,
} from "../types";

const TOWER_SNAPSHOT_VERSION = 1;
const TOWER_SNAPSHOT_MAX_BLOCKS = 500;

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === "number" && Number.isFinite(value);
};

const isBlockState = (value: unknown): value is BlockState => {
  return value === "active" || value === "stopped" || value === "missed";
};

const isBlockSnapshot = (value: unknown): value is BlockSnapshot => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const dimension = record.dimension as Record<string, unknown> | undefined;
  const position = record.position as Record<string, unknown> | undefined;
  return (
    !!dimension &&
    isFiniteNumber(dimension.width) &&
    dimension.width > 0 &&
    isFiniteNumber(dimension.height) &&
    dimension.height > 0 &&
    isFiniteNumber(dimension.depth) &&
    dimension.depth > 0 &&
    !!position &&
    isFiniteNumber(position.x) &&
    isFiniteNumber(position.y) &&
    isFiniteNumber(position.z) &&
    isFiniteNumber(record.direction) &&
    isBlockState(record.state)
  );
};

const isTowerSnapshot = (value: unknown): value is TowerSnapshot => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === TOWER_SNAPSHOT_VERSION &&
    (record.state === "playing" || record.state === "ended") &&
    (record.deadlineMs === null || isFiniteNumber(record.deadlineMs)) &&
    isFiniteNumber(record.timeLeft) &&
    isFiniteNumber(record.colorOffset) &&
    isFiniteNumber(record.score) &&
    (record.score as number) >= 0 &&
    Array.isArray(record.blocks) &&
    record.blocks.length > 0 &&
    record.blocks.length <= TOWER_SNAPSHOT_MAX_BLOCKS &&
    record.blocks.every(isBlockSnapshot)
  );
};

export class Game {
  static readonly STATES = {
    LOADING: "loading" as GameState,
    PLAYING: "playing" as GameState,
    READY: "ready" as GameState,
    ENDED: "ended" as GameState,
    RESETING: "reseting" as GameState,
  };

  static readonly TIME_LIMIT = 60;

  static snapshotKey(eventKey: string): string {
    return `towerblock:${eventKey}`;
  }

  static loadSnapshot(eventKey: string): TowerSnapshot | null {
    try {
      const raw = window.sessionStorage.getItem(Game.snapshotKey(eventKey));
      if (!raw) {
        return null;
      }
      const parsed: unknown = JSON.parse(raw);
      return isTowerSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  static clearSnapshot(eventKey: string): void {
    try {
      window.sessionStorage.removeItem(Game.snapshotKey(eventKey));
    } catch {
      return;
    }
  }

  private blocks: Block[] = [];
  private state: GameState = Game.STATES.LOADING;

  private stage: Stage;

  private newBlocks: THREE.Group;
  private placedBlocks: THREE.Group;
  private choppedBlocks: THREE.Group;

  private mainContainer: HTMLElement;
  private scoreContainer: HTMLElement;
  private timerContainer: HTMLElement;
  private startButton: HTMLElement;
  private instructions: HTMLElement;
  private eventKey: string;

  private animationId: number | null = null;
  private timerInterval: NodeJS.Timeout | null = null;
  private timeLeft: number = Game.TIME_LIMIT;
  private deadlineMs: number | null = null;
  private restoredScore: number | null = null;

  constructor(
    containerRef: HTMLElement,
    scoreRef: HTMLElement,
    timerRef: HTMLElement,
    startButtonRef: HTMLElement,
    instructionsRef: HTMLElement,
    mainContainerRef: HTMLElement,
    eventKey: string
  ) {
    this.mainContainer = mainContainerRef;
    this.scoreContainer = scoreRef;
    this.timerContainer = timerRef;
    this.startButton = startButtonRef;
    this.instructions = instructionsRef;
    this.eventKey = eventKey;

    this.stage = new Stage(containerRef);

    this.newBlocks = new THREE.Group();
    this.placedBlocks = new THREE.Group();
    this.choppedBlocks = new THREE.Group();

    this.stage.add(this.newBlocks);
    this.stage.add(this.placedBlocks);
    this.stage.add(this.choppedBlocks);

    this.addBlock();
    this.tick();

    this.updateState(Game.STATES.READY);
  }

  private updateState(newState: GameState): void {
    this.mainContainer.classList.remove(
      Game.STATES.LOADING,
      Game.STATES.PLAYING,
      Game.STATES.READY,
      Game.STATES.ENDED,
      Game.STATES.RESETING
    );
    this.mainContainer.classList.add(newState);
    this.state = newState;
  }

  getState(): GameState {
    return this.state;
  }

  onAction(): void {
    switch (this.state) {
      case Game.STATES.READY:
        this.startGame();
        break;
      case Game.STATES.PLAYING:
        this.placeBlock();
        break;
      case Game.STATES.ENDED:
        break;
    }
  }

  private startTimer(): void {
    this.deadlineMs = Date.now() + Game.TIME_LIMIT * 1000;
    this.timeLeft = Game.TIME_LIMIT;
    this.updateTimerDisplay();
    this.armTimerInterval();
  }

  private resumeTimer(deadlineMs: number, timeLeft: number): void {
    this.deadlineMs = deadlineMs;
    this.timeLeft = timeLeft;
    this.updateTimerDisplay();
    this.armTimerInterval();
  }

  private armTimerInterval(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    this.timerInterval = setInterval(() => {
      if (this.deadlineMs === null) {
        this.timeLeft--;
      } else {
        this.timeLeft = Math.max(
          0,
          Math.ceil((this.deadlineMs - Date.now()) / 1000)
        );
      }
      this.updateTimerDisplay();
      this.saveSnapshot();

      if (this.timeLeft <= 0) {
        this.stopTimer();
        this.endGame();
      }
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private resetTimer(): void {
    this.stopTimer();
    this.deadlineMs = null;
    this.timeLeft = Game.TIME_LIMIT;
    this.updateTimerDisplay();
  }

  private saveSnapshot(): void {
    try {
      const snapshot: TowerSnapshot = {
        version: TOWER_SNAPSHOT_VERSION,
        state: this.state,
        deadlineMs:
          this.state === Game.STATES.PLAYING ? this.deadlineMs : null,
        timeLeft: this.timeLeft,
        colorOffset:
          this.blocks.length > 0 ? this.blocks[0].colorOffset : 0,
        score: this.getScore(),
        blocks: this.blocks
          .filter((block) => block.state !== Block.STATES.MISSED)
          .map((block) => ({
            dimension: { ...block.dimension },
            position: { ...block.position },
            direction: block.direction,
            state: block.state,
          })),
      };
      window.sessionStorage.setItem(
        Game.snapshotKey(this.eventKey),
        JSON.stringify(snapshot)
      );
    } catch {
      return;
    }
  }

  restoreSnapshot(snapshot: TowerSnapshot): void {
    if (!isTowerSnapshot(snapshot) || snapshot.blocks.length === 0) {
      return;
    }

    this.stopTimer();

    const rebuilt: Block[] = [];
    let previous: Block | null = null;
    for (const blockSnapshot of snapshot.blocks) {
      const block: Block = new Block(previous);
      block.restoreFromSnapshot(blockSnapshot, snapshot.colorOffset);
      rebuilt.push(block);
      previous = block;
    }

    while (this.newBlocks.children.length > 0) {
      this.newBlocks.remove(this.newBlocks.children[0]);
    }
    while (this.placedBlocks.children.length > 0) {
      this.placedBlocks.remove(this.placedBlocks.children[0]);
    }
    while (this.choppedBlocks.children.length > 0) {
      this.choppedBlocks.remove(this.choppedBlocks.children[0]);
    }

    this.blocks = rebuilt;
    for (const block of this.blocks) {
      if (block.state === Block.STATES.ACTIVE) {
        this.newBlocks.add(block.mesh);
      } else {
        this.placedBlocks.add(block.mesh);
      }
    }

    this.restoredScore = snapshot.score;
    this.stage.setCamera(this.blocks.length * 2);
    this.scoreContainer.innerHTML = `점수: ${this.getScore()}점`;

    if (snapshot.state === Game.STATES.ENDED) {
      this.timeLeft = Math.max(0, snapshot.timeLeft);
      this.updateTimerDisplay();
      this.updateState(Game.STATES.ENDED);
      this.saveSnapshot();
      return;
    }

    const remaining =
      snapshot.deadlineMs === null
        ? Math.max(0, snapshot.timeLeft)
        : Math.max(0, Math.ceil((snapshot.deadlineMs - Date.now()) / 1000));

    if (remaining <= 0) {
      this.timeLeft = 0;
      this.updateTimerDisplay();
      this.endGame();
      return;
    }

    this.updateState(Game.STATES.PLAYING);
    this.resumeTimer(
      snapshot.deadlineMs ?? Date.now() + remaining * 1000,
      remaining
    );
    this.saveSnapshot();
  }

  private updateTimerDisplay(): void {
    this.timerContainer.innerHTML = `제한시간: ${this.timeLeft}초`;
    
    if (this.timeLeft <= 10) {
      this.timerContainer.classList.add("warning");
    } else {
      this.timerContainer.classList.remove("warning");
    }
  }

  private startGame(): void {
    if (this.state !== Game.STATES.PLAYING) {
      this.scoreContainer.innerHTML = "점수: 0점";
      this.restoredScore = null;
      this.updateState(Game.STATES.PLAYING);
      this.startTimer();
      this.addBlock();
      this.saveSnapshot();
    }
  }

  private restartGame(): void {
    this.updateState(Game.STATES.RESETING);
    this.stopTimer();

    while (this.newBlocks.children.length > 0) {
      this.newBlocks.remove(this.newBlocks.children[0]);
    }
    while (this.placedBlocks.children.length > 0) {
      this.placedBlocks.remove(this.placedBlocks.children[0]);
    }
    while (this.choppedBlocks.children.length > 0) {
      this.choppedBlocks.remove(this.choppedBlocks.children[0]);
    }

    this.blocks = [];

    this.stage.setCamera(2, 0.3);

    const cameraMoveSpeed = 0.5;

    setTimeout(() => {
      this.resetTimer();
      this.startGame();
    }, cameraMoveSpeed * 1000);
  }

  private placeBlock(): void {
    const currentBlock = this.blocks[this.blocks.length - 1];
    const newBlocks: BlockReturn = currentBlock.place();
    this.newBlocks.remove(currentBlock.mesh);

    if (newBlocks.placed) {
      this.placedBlocks.add(newBlocks.placed);
    }

    if (newBlocks.chopped) {
      this.choppedBlocks.add(newBlocks.chopped);
      const positionParams: Record<string, unknown> = {
        y: "-=30",
        ease: "power1.in",
        duration: 1,
        onComplete: () => this.choppedBlocks.remove(newBlocks.chopped!),
      };

      const rotateRandomness = 10;
      const rotationParams = {
        delay: 0.05,
        duration: 1,
        x:
          newBlocks.plane === "z"
            ? Math.random() * rotateRandomness - rotateRandomness / 2
            : 0.1,
        z:
          newBlocks.plane === "x"
            ? Math.random() * rotateRandomness - rotateRandomness / 2
            : 0.1,
        y: Math.random() * 0.1,
      };

      if (
        newBlocks.chopped.position[newBlocks.plane] >
        newBlocks.placed!.position[newBlocks.plane]
      ) {
        positionParams[newBlocks.plane] =
          "+=" + 40 * Math.abs(newBlocks.direction);
      } else {
        positionParams[newBlocks.plane] =
          "-=" + 40 * Math.abs(newBlocks.direction);
      }

      gsap.to(newBlocks.chopped.position, positionParams);
      gsap.to(newBlocks.chopped.rotation, rotationParams);
    }

    this.addBlock();
    this.saveSnapshot();
  }

  private addBlock(): void {
    const lastBlock = this.blocks[this.blocks.length - 1];

    if (lastBlock && lastBlock.state === Block.STATES.MISSED) {
      this.endGame();
      return;
    }

    this.restoredScore = null;
    this.scoreContainer.innerHTML = `점수: ${Math.max(0, this.blocks.length - 1)}점`;

    const newKidOnTheBlock = new Block(lastBlock || null);
    
    if (newKidOnTheBlock.state === Block.STATES.STOPPED) {
      this.placedBlocks.add(newKidOnTheBlock.mesh);
    } else {
      this.newBlocks.add(newKidOnTheBlock.mesh);
    }
    
    this.blocks.push(newKidOnTheBlock);

    this.stage.setCamera(this.blocks.length * 2);

    if (this.blocks.length >= 5) {
      this.instructions.classList.add("hide");
    }
  }

  private endGame(): void {
    this.stopTimer();
    this.updateState(Game.STATES.ENDED);
    this.saveSnapshot();
  }

  getScore(): number {
    if (this.restoredScore !== null) {
      return this.restoredScore;
    }
    return Math.max(0, this.blocks.length - 1);
  }

  private tick = (): void => {
    if (this.blocks.length > 0) {
      this.blocks[this.blocks.length - 1].tick();
    }
    this.stage.render();
    this.animationId = requestAnimationFrame(this.tick);
  };

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.stopTimer();
    
    while (this.newBlocks.children.length > 0) {
      this.newBlocks.remove(this.newBlocks.children[0]);
    }
    while (this.placedBlocks.children.length > 0) {
      this.placedBlocks.remove(this.placedBlocks.children[0]);
    }
    while (this.choppedBlocks.children.length > 0) {
      this.choppedBlocks.remove(this.choppedBlocks.children[0]);
    }
    
    this.blocks = [];
    this.stage.dispose();
  }
}
