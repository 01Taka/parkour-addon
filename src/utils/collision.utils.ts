import {
  Block,
  Direction,
  type Vector3,
  type BlockRaycastOptions,
} from "@minecraft/server";

// ==========================================
// 殴打面（hitFace）起点による当たり判定判定
// ==========================================

/**
 * 判定面に対するレイの定義情報
 */
export interface FaceRayDefinition {
  readonly name: string;
  readonly startLocation: Vector3;
  readonly direction: Vector3;
  readonly maxDistance: number;
}

/**
 * 指定した面の隣接ブロックを取得します。
 */
export function getAdjacentBlock(
  block: Block,
  face: Direction,
): Block | undefined {
  switch (face) {
    case Direction.Up:
      return block.above();
    case Direction.Down:
      return block.below();
    case Direction.North:
      return block.north();
    case Direction.South:
      return block.south();
    case Direction.East:
      return block.east();
    case Direction.West:
      return block.west();
    default:
      return undefined;
  }
}

/**
 * 指定した面に対する照射レイ定義（中央1本、または4つ角4本）を生成します。
 */
export function getFaceRayDefinitions(
  block: Block,
  face: Direction,
  isCornerMode: boolean,
): FaceRayDefinition[] {
  const { x, y, z } = block.location;
  const OFFSET = 0.05;
  const C_MIN = 0.15;
  const C_MAX = 0.85;
  const MAX_DIST = 1.1;

  switch (face) {
    case Direction.Up: {
      const dir: Vector3 = { x: 0, y: -1, z: 0 };
      const startY = y + 1.0 + OFFSET;
      if (!isCornerMode) {
        return [
          {
            name: "Center",
            startLocation: { x: x + 0.5, y: startY, z: z + 0.5 },
            direction: dir,
            maxDistance: MAX_DIST,
          },
        ];
      }
      return [
        {
          name: "Corner 1 (NW)",
          startLocation: { x: x + C_MIN, y: startY, z: z + C_MIN },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 2 (NE)",
          startLocation: { x: x + C_MAX, y: startY, z: z + C_MIN },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 3 (SW)",
          startLocation: { x: x + C_MIN, y: startY, z: z + C_MAX },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 4 (SE)",
          startLocation: { x: x + C_MAX, y: startY, z: z + C_MAX },
          direction: dir,
          maxDistance: MAX_DIST,
        },
      ];
    }
    case Direction.Down: {
      const dir: Vector3 = { x: 0, y: 1, z: 0 };
      const startY = y - OFFSET;
      if (!isCornerMode) {
        return [
          {
            name: "Center",
            startLocation: { x: x + 0.5, y: startY, z: z + 0.5 },
            direction: dir,
            maxDistance: MAX_DIST,
          },
        ];
      }
      return [
        {
          name: "Corner 1 (NW)",
          startLocation: { x: x + C_MIN, y: startY, z: z + C_MIN },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 2 (NE)",
          startLocation: { x: x + C_MAX, y: startY, z: z + C_MIN },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 3 (SW)",
          startLocation: { x: x + C_MIN, y: startY, z: z + C_MAX },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 4 (SE)",
          startLocation: { x: x + C_MAX, y: startY, z: z + C_MAX },
          direction: dir,
          maxDistance: MAX_DIST,
        },
      ];
    }
    case Direction.North: {
      const dir: Vector3 = { x: 0, y: 0, z: 1 };
      const startZ = z - OFFSET;
      if (!isCornerMode) {
        return [
          {
            name: "Center",
            startLocation: { x: x + 0.5, y: y + 0.5, z: startZ },
            direction: dir,
            maxDistance: MAX_DIST,
          },
        ];
      }
      return [
        {
          name: "Corner 1 (BottomLeft)",
          startLocation: { x: x + C_MIN, y: y + C_MIN, z: startZ },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 2 (BottomRight)",
          startLocation: { x: x + C_MAX, y: y + C_MIN, z: startZ },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 3 (TopLeft)",
          startLocation: { x: x + C_MIN, y: y + C_MAX, z: startZ },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 4 (TopRight)",
          startLocation: { x: x + C_MAX, y: y + C_MAX, z: startZ },
          direction: dir,
          maxDistance: MAX_DIST,
        },
      ];
    }
    case Direction.South: {
      const dir: Vector3 = { x: 0, y: 0, z: -1 };
      const startZ = z + 1.0 + OFFSET;
      if (!isCornerMode) {
        return [
          {
            name: "Center",
            startLocation: { x: x + 0.5, y: y + 0.5, z: startZ },
            direction: dir,
            maxDistance: MAX_DIST,
          },
        ];
      }
      return [
        {
          name: "Corner 1 (BottomLeft)",
          startLocation: { x: x + C_MIN, y: y + C_MIN, z: startZ },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 2 (BottomRight)",
          startLocation: { x: x + C_MAX, y: y + C_MIN, z: startZ },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 3 (TopLeft)",
          startLocation: { x: x + C_MIN, y: y + C_MAX, z: startZ },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 4 (TopRight)",
          startLocation: { x: x + C_MAX, y: y + C_MAX, z: startZ },
          direction: dir,
          maxDistance: MAX_DIST,
        },
      ];
    }
    case Direction.West: {
      const dir: Vector3 = { x: 1, y: 0, z: 0 };
      const startX = x - OFFSET;
      if (!isCornerMode) {
        return [
          {
            name: "Center",
            startLocation: { x: startX, y: y + 0.5, z: z + 0.5 },
            direction: dir,
            maxDistance: MAX_DIST,
          },
        ];
      }
      return [
        {
          name: "Corner 1 (BottomNorth)",
          startLocation: { x: startX, y: y + C_MIN, z: z + C_MIN },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 2 (BottomSouth)",
          startLocation: { x: startX, y: y + C_MIN, z: z + C_MAX },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 3 (TopNorth)",
          startLocation: { x: startX, y: y + C_MAX, z: z + C_MIN },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 4 (TopSouth)",
          startLocation: { x: startX, y: y + C_MAX, z: z + C_MAX },
          direction: dir,
          maxDistance: MAX_DIST,
        },
      ];
    }
    case Direction.East: {
      const dir: Vector3 = { x: -1, y: 0, z: 0 };
      const startX = x + 1.0 + OFFSET;
      if (!isCornerMode) {
        return [
          {
            name: "Center",
            startLocation: { x: startX, y: y + 0.5, z: z + 0.5 },
            direction: dir,
            maxDistance: MAX_DIST,
          },
        ];
      }
      return [
        {
          name: "Corner 1 (BottomNorth)",
          startLocation: { x: startX, y: y + C_MIN, z: z + C_MIN },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 2 (BottomSouth)",
          startLocation: { x: startX, y: y + C_MIN, z: z + C_MAX },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 3 (TopNorth)",
          startLocation: { x: startX, y: y + C_MAX, z: z + C_MIN },
          direction: dir,
          maxDistance: MAX_DIST,
        },
        {
          name: "Corner 4 (TopSouth)",
          startLocation: { x: startX, y: y + C_MAX, z: z + C_MAX },
          direction: dir,
          maxDistance: MAX_DIST,
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * 殴打面（指定面）の外側からレイキャストを照射して当たり判定を検証する。
 * 指定面に隣接するブロックが空気(Air)なら中央から1本、
 * 空気以外（階段やハーフブロック等）なら隙間からの殴打を考慮して4つ角から4本のレイを照射する。
 * （どれか1本でもヒットすれば true）
 *
 * @param block 判定対象のブロック
 * @param face 照射する面（殴られた面: hitFace）
 * @returns 当たり判定があれば true、通り抜けられるなら false
 */
export function hasBlockCollisionFromFace(
  block: Block | undefined,
  face: Direction,
): boolean {
  if (!block || block.isAir || block.isLiquid) {
    return false;
  }

  const adjacentBlock = getAdjacentBlock(block, face);
  const isAdjacentAir = adjacentBlock ? adjacentBlock.isAir : true;
  const isCornerMode = !isAdjacentAir;

  const rayDefs = getFaceRayDefinitions(block, face, isCornerMode);
  const { x, y, z } = block.location;

  const options: BlockRaycastOptions = {
    maxDistance: 1.1,
    includePassableBlocks: false, // 草・花・松明などのすり抜け可能ブロックは除外
    includeLiquidBlocks: false, // 水や溶岩も除外
  };

  for (const ray of rayDefs) {
    const hit = block.dimension.getBlockFromRay(
      ray.startLocation,
      ray.direction,
      options,
    );

    if (
      hit !== undefined &&
      hit.block.location.x === x &&
      hit.block.location.y === y &&
      hit.block.location.z === z
    ) {
      return true;
    }
  }

  return false;
}

// ==========================================
// 6面の空気面起点による当たり判定判定
// ==========================================

export const ALL_BLOCK_FACES: readonly Direction[] = [
  Direction.Up,
  Direction.Down,
  Direction.North,
  Direction.South,
  Direction.East,
  Direction.West,
];

/**
 * 指定した面の中央外側からブロック中心に向けて照射するレイの定義を取得します。
 */
export function getFaceCenterRayDefinition(
  block: Block,
  face: Direction,
): FaceRayDefinition {
  const { x, y, z } = block.location;
  const OFFSET = 0.05;
  const MAX_DIST = 1.1;

  switch (face) {
    case Direction.Up:
      return {
        name: "Up",
        startLocation: { x: x + 0.5, y: y + 1.0 + OFFSET, z: z + 0.5 },
        direction: { x: 0, y: -1, z: 0 },
        maxDistance: MAX_DIST,
      };
    case Direction.Down:
      return {
        name: "Down",
        startLocation: { x: x + 0.5, y: y - OFFSET, z: z + 0.5 },
        direction: { x: 0, y: 1, z: 0 },
        maxDistance: MAX_DIST,
      };
    case Direction.North:
      return {
        name: "North",
        startLocation: { x: x + 0.5, y: y + 0.5, z: z - OFFSET },
        direction: { x: 0, y: 0, z: 1 },
        maxDistance: MAX_DIST,
      };
    case Direction.South:
      return {
        name: "South",
        startLocation: { x: x + 0.5, y: y + 0.5, z: z + 1.0 + OFFSET },
        direction: { x: 0, y: 0, z: -1 },
        maxDistance: MAX_DIST,
      };
    case Direction.West:
      return {
        name: "West",
        startLocation: { x: x - OFFSET, y: y + 0.5, z: z + 0.5 },
        direction: { x: 1, y: 0, z: 0 },
        maxDistance: MAX_DIST,
      };
    case Direction.East:
      return {
        name: "East",
        startLocation: { x: x + 1.0 + OFFSET, y: y + 0.5, z: z + 0.5 },
        direction: { x: -1, y: 0, z: 0 },
        maxDistance: MAX_DIST,
      };
  }
}

/**
 * 指定したブロックの6面（上下東西南北）のうち、空気に面している面からブロック中心へレイキャストを照射して当たり判定を判定します。
 * 空気に面している面からのレイキャストが1つでもヒットすれば当たり判定あり (true) と判定します。
 * 6面すべてが空気ではない場合、引数 fallbackIfNoAirFaces の値を返します（デフォルト: true = コリジョンあり）。
 *
 * @param block 判定対象のブロック
 * @param fallbackIfNoAirFaces 6面とも空気ではない場合の返り値（デフォルト: true）
 * @returns 当たり判定があれば true、通り抜けられるなら false
 */
export function hasBlockCollisionFromAirFaces(
  block: Block | undefined,
  fallbackIfNoAirFaces: boolean = true,
): boolean {
  // 空気や液体はレイキャストするまでもなく当たり判定なし
  if (!block || block.isAir || block.isLiquid) {
    return false;
  }

  const { x, y, z } = block.location;
  const options: BlockRaycastOptions = {
    maxDistance: 1.1,
    includePassableBlocks: false, // 草・花・松明などのすり抜け可能ブロックは除外
    includeLiquidBlocks: false, // 水や溶岩も除外
  };

  let airFaceCount = 0;

  for (const face of ALL_BLOCK_FACES) {
    const adjacent = getAdjacentBlock(block, face);
    // 隣接が空気（Air）の面のみを対象とする
    if (adjacent && adjacent.isAir) {
      airFaceCount++;
      const ray = getFaceCenterRayDefinition(block, face);
      const hit = block.dimension.getBlockFromRay(
        ray.startLocation,
        ray.direction,
        options,
      );

      if (
        hit !== undefined &&
        hit.block.location.x === x &&
        hit.block.location.y === y &&
        hit.block.location.z === z
      ) {
        return true;
      }
    }
  }

  // 6面とも空気ではない場合は fallbackIfNoAirFaces の値を返す
  if (airFaceCount === 0) {
    return fallbackIfNoAirFaces;
  }

  // 空気の面があったにもかかわらず1つも当たらなかった場合（松明・草花など）
  return false;
}
