export const SIZE = 4;
export const WIN_TARGET = 2048;

export type Board = number[][];
export type Direction = "up" | "down" | "left" | "right";

export interface MoveResult {
  board: Board;
  gained: number;
  moved: boolean;
}

/** 4x4 빈 보드 생성 */
export function createEmptyBoard(size: number = SIZE): Board {
  return Array.from({ length: size }, () => Array<number>(size).fill(0));
}

function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

function boardsEqual(a: Board, b: Board): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r += 1) {
    for (let c = 0; c < a[r].length; c += 1) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

/**
 * 한 줄을 왼쪽으로 밀착 후 같은 숫자끼리 한 번씩만 합성.
 * 예: [2,2,4,4] -> [4,8,0,0], gained 12 / [4,4,8,0] -> [8,8,0,0]
 */
export function slideAndMergeLine(line: readonly number[]): {
  line: number[];
  gained: number;
} {
  const compacted = line.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  let i = 0;
  while (i < compacted.length) {
    if (i + 1 < compacted.length && compacted[i] === compacted[i + 1]) {
      const merged = compacted[i] * 2;
      out.push(merged);
      gained += merged;
      i += 2;
    } else {
      out.push(compacted[i]);
      i += 1;
    }
  }
  while (out.length < line.length) out.push(0);
  return { line: out, gained };
}

function reverseRows(board: Board): Board {
  return board.map((row) => [...row].reverse());
}

function transpose(board: Board): Board {
  const n = board.length;
  const out = createEmptyBoard(n);
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      out[c][r] = board[r][c];
    }
  }
  return out;
}

function moveLeft(board: Board): MoveResult {
  const next: Board = [];
  let gained = 0;
  for (const row of board) {
    const { line, gained: g } = slideAndMergeLine(row);
    next.push(line);
    gained += g;
  }
  return { board: next, gained, moved: !boardsEqual(board, next) };
}

/**
 * 이동·합성을 수행한다. 점수 가산분(gained)과 실제 이동 여부(moved)를 함께 반환.
 * 이동이 없으면 보드는 동일 내용의 새 배열로 반환된다.
 */
export function move(board: Board, direction: Direction): MoveResult {
  switch (direction) {
    case "left": {
      return moveLeft(board);
    }
    case "right": {
      const flipped = reverseRows(board);
      const res = moveLeft(flipped);
      return { board: reverseRows(res.board), gained: res.gained, moved: res.moved };
    }
    case "up": {
      const t = transpose(board);
      const res = moveLeft(t);
      return { board: transpose(res.board), gained: res.gained, moved: res.moved };
    }
    case "down": {
      const t = transpose(board);
      const flipped = reverseRows(t);
      const res = moveLeft(flipped);
      return {
        board: transpose(reverseRows(res.board)),
        gained: res.gained,
        moved: res.moved,
      };
    }
  }
}

/** 빈 칸 좌표 목록 */
export function emptyCells(board: Board): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let r = 0; r < board.length; r += 1) {
    for (let c = 0; c < board[r].length; c += 1) {
      if (board[r][c] === 0) cells.push([r, c]);
    }
  }
  return cells;
}

/**
 * 랜덤 빈 칸 하나에 2(90%) / 4(10%) 스폰한 새 보드를 반환.
 * 빈 칸이 없으면 복사본을 그대로 반환한다.
 */
export function spawnRandomTile(
  board: Board,
  rand: () => number = Math.random,
): Board {
  const next = cloneBoard(board);
  const empties = emptyCells(next);
  if (empties.length === 0) return next;
  const pick = Math.floor(rand() * empties.length);
  const [r, c] = empties[pick];
  next[r][c] = rand() < 0.9 ? 2 : 4;
  return next;
}

/** 시작 보드: 빈 보드에 타일 2개 스폰 */
export function createInitialBoard(rand: () => number = Math.random): Board {
  let board = createEmptyBoard();
  board = spawnRandomTile(board, rand);
  board = spawnRandomTile(board, rand);
  return board;
}

/** 한 칸이라도 이동·합성 가능하면 true */
export function canMove(board: Board): boolean {
  if (emptyCells(board).length > 0) return true;
  const dirs: Direction[] = ["up", "down", "left", "right"];
  for (const d of dirs) {
    const res = move(board, d);
    if (res.moved) return true;
  }
  return false;
}

/** 목표값(기본 2048) 이상 타일이 있으면 true */
export function hasWon(board: Board, target: number = WIN_TARGET): boolean {
  return board.some((row) => row.some((v) => v >= target));
}
