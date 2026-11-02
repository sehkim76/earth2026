import * as THREE from "three";
import type {
  BlockSnapshot,
  BlockState,
  WorkingPlane,
  WorkingDimension,
  Dimension,
  Position,
  BlockReturn,
} from "../types";

export class Block {
  static readonly STATES = {
    ACTIVE: "active" as BlockState,
    STOPPED: "stopped" as BlockState,
    MISSED: "missed" as BlockState,
  };

  static readonly MOVE_AMOUNT = 12;

  readonly index: number;
  workingPlane: WorkingPlane;
  workingDimension: WorkingDimension;

  dimension: Dimension;
  position: Position;

  mesh: THREE.Mesh;
  state: BlockState;
  speed: number;
  direction: number;
  colorOffset: number;
  color: THREE.Color | number;
  material: THREE.MeshToonMaterial;

  targetBlock: Block | null;

  constructor(block: Block | null) {
    this.targetBlock = block;

    this.index = (this.targetBlock ? this.targetBlock.index : 0) + 1;
    this.workingPlane = this.index % 2 ? "x" : "z";
    this.workingDimension = this.index % 2 ? "width" : "depth";

    this.dimension = {
      width: this.targetBlock ? this.targetBlock.dimension.width : 10,
      height: this.targetBlock ? this.targetBlock.dimension.height : 2,
      depth: this.targetBlock ? this.targetBlock.dimension.depth : 10,
    };

    this.position = {
      x: this.targetBlock ? this.targetBlock.position.x : 0,
      y: this.targetBlock
        ? this.targetBlock.position.y + this.dimension.height
        : 0,
      z: this.targetBlock ? this.targetBlock.position.z : 0,
    };

    this.colorOffset = this.targetBlock
      ? this.targetBlock.colorOffset
      : Math.round(Math.random() * 100);

    if (!this.targetBlock) {
      this.color = 0x333344;
    } else {
      const offset = this.index + this.colorOffset;
      const r = Math.sin(0.3 * offset) * 55 + 200;
      const g = Math.sin(0.3 * offset + 2) * 55 + 200;
      const b = Math.sin(0.3 * offset + 4) * 55 + 200;
      this.color = new THREE.Color(r / 255, g / 255, b / 255);
    }

    this.state =
      this.index > 1 ? Block.STATES.ACTIVE : Block.STATES.STOPPED;

    this.speed = -0.1 - this.index * 0.005;
    if (this.speed < -4) this.speed = -4;
    this.direction = this.speed;

    const geometry = new THREE.BoxGeometry(
      this.dimension.width,
      this.dimension.height,
      this.dimension.depth
    );
    geometry.applyMatrix4(
      new THREE.Matrix4().makeTranslation(
        this.dimension.width / 2,
        this.dimension.height / 2,
        this.dimension.depth / 2
      )
    );
    this.material = new THREE.MeshToonMaterial({
      color: this.color,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.set(this.position.x, this.position.y, this.position.z);

    if (this.state === Block.STATES.ACTIVE) {
      this.position[this.workingPlane] =
        Math.random() > 0.5 ? -Block.MOVE_AMOUNT : Block.MOVE_AMOUNT;
    }
  }

  reverseDirection(): void {
    this.direction =
      this.direction > 0 ? this.speed : Math.abs(this.speed);
  }

  restoreFromSnapshot(snapshot: BlockSnapshot, colorOffset: number): void {
    this.dimension = {
      width: snapshot.dimension.width,
      height: snapshot.dimension.height,
      depth: snapshot.dimension.depth,
    };
    this.position = {
      x: snapshot.position.x,
      y: snapshot.position.y,
      z: snapshot.position.z,
    };
    this.direction = snapshot.direction;
    this.state = snapshot.state;
    this.colorOffset = colorOffset;

    if (!this.targetBlock) {
      this.color = 0x333344;
    } else {
      const offset = this.index + this.colorOffset;
      const r = Math.sin(0.3 * offset) * 55 + 200;
      const g = Math.sin(0.3 * offset + 2) * 55 + 200;
      const b = Math.sin(0.3 * offset + 4) * 55 + 200;
      this.color = new THREE.Color(r / 255, g / 255, b / 255);
    }

    const geometry = new THREE.BoxGeometry(
      this.dimension.width,
      this.dimension.height,
      this.dimension.depth
    );
    geometry.applyMatrix4(
      new THREE.Matrix4().makeTranslation(
        this.dimension.width / 2,
        this.dimension.height / 2,
        this.dimension.depth / 2
      )
    );
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    this.material.dispose();
    this.material = new THREE.MeshToonMaterial({
      color: this.color,
    });
    this.mesh.material = this.material;
    this.mesh.position.set(this.position.x, this.position.y, this.position.z);
  }

  place(): BlockReturn {
    this.state = Block.STATES.STOPPED;

    const overlap =
      this.targetBlock!.dimension[this.workingDimension] -
      Math.abs(
        this.position[this.workingPlane] -
          this.targetBlock!.position[this.workingPlane]
      );

    const blocksToReturn: BlockReturn = {
      plane: this.workingPlane,
      direction: this.direction,
    };

    if (this.dimension[this.workingDimension] - overlap < 0.3) {
      this.position.x = this.targetBlock!.position.x;
      this.position.z = this.targetBlock!.position.z;
      this.dimension.width = this.targetBlock!.dimension.width;
      this.dimension.depth = this.targetBlock!.dimension.depth;
      blocksToReturn.bonus = true;
      return blocksToReturn;
    }

    if (overlap > 0) {
      const choppedDimensions: Dimension = {
        width: this.dimension.width,
        height: this.dimension.height,
        depth: this.dimension.depth,
      };
      choppedDimensions[this.workingDimension] -= overlap;
      this.dimension[this.workingDimension] = overlap;

      const placedGeometry = new THREE.BoxGeometry(
        this.dimension.width,
        this.dimension.height,
        this.dimension.depth
      );
      placedGeometry.applyMatrix4(
        new THREE.Matrix4().makeTranslation(
          this.dimension.width / 2,
          this.dimension.height / 2,
          this.dimension.depth / 2
        )
      );
      const placedMesh = new THREE.Mesh(placedGeometry, this.material);

      const choppedGeometry = new THREE.BoxGeometry(
        choppedDimensions.width,
        choppedDimensions.height,
        choppedDimensions.depth
      );
      choppedGeometry.applyMatrix4(
        new THREE.Matrix4().makeTranslation(
          choppedDimensions.width / 2,
          choppedDimensions.height / 2,
          choppedDimensions.depth / 2
        )
      );
      const choppedMesh = new THREE.Mesh(choppedGeometry, this.material);

      const choppedPosition: Position = {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      };

      if (
        this.position[this.workingPlane] <
        this.targetBlock!.position[this.workingPlane]
      ) {
        this.position[this.workingPlane] =
          this.targetBlock!.position[this.workingPlane];
      } else {
        choppedPosition[this.workingPlane] += overlap;
      }

      placedMesh.position.set(
        this.position.x,
        this.position.y,
        this.position.z
      );
      choppedMesh.position.set(
        choppedPosition.x,
        choppedPosition.y,
        choppedPosition.z
      );

      blocksToReturn.placed = placedMesh;
      blocksToReturn.chopped = choppedMesh;
    } else {
      this.state = Block.STATES.MISSED;
    }

    this.dimension[this.workingDimension] = overlap;

    return blocksToReturn;
  }

  tick(): void {
    if (this.state === Block.STATES.ACTIVE) {
      const value = this.position[this.workingPlane];
      if (value > Block.MOVE_AMOUNT || value < -Block.MOVE_AMOUNT) {
        this.reverseDirection();
      }
      this.position[this.workingPlane] += this.direction;
      this.mesh.position[this.workingPlane] = this.position[this.workingPlane];
    }
  }
}
