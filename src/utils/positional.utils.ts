import { type Block, type Player, type Vector3 } from "@minecraft/server";

export interface AABB {
  min: Vector3;
  max: Vector3;
}

export interface AABBDistanceResult {
  /** XZ平面（水平方向）のAABB最短距離 */
  horizontal: number;
  /** Y軸（垂直方向）のAABB最短距離 (内側にある場合は 0) */
  vertical: number;
  /** 3次元空間におけるAABB最短直線距離 */
  distance: number;
  /** 各軸の最短距離 (内側にある場合は 0) */
  delta: {
    dx: number;
    dy: number;
    dz: number;
  };
  /**
   * ブロック上面を基準とした垂直距離 (point.y - maxY):
   * - 正: 上面より上
   * - 負: 上面より下 (AABB範囲内含む)
   * - 0: 上面と一致
   */
  verticalTop: number;
  /**
   * ブロック下面を基準とした垂直距離 (point.y - minY):
   * - 正: 下面より上 (AABB範囲内含む)
   * - 負: 下面より下
   * - 0: 下面と一致
   */
  verticalBottom: number;
}

/**
 * 3次元空間の任意の点とAABBバウンディングボックス間の距離を計算します。
 *
 * @param point 測定対象の点（プレイヤー位置など）
 * @param aabb 測定対象のAABB { min, max }
 * @returns 水平距離、垂直距離、直線距離を含む AABBDistanceResult
 */
export function calculatePointToAABBDistance(
  point: Vector3,
  aabb: AABB,
): AABBDistanceResult {
  // 各軸においてAABB外側にはみ出している距離を算出（内側なら0）
  const dx = Math.max(aabb.min.x - point.x, 0, point.x - aabb.max.x);
  const dy = Math.max(aabb.min.y - point.y, 0, point.y - aabb.max.y);
  const dz = Math.max(aabb.min.z - point.z, 0, point.z - aabb.max.z);

  const horizontal = Math.hypot(dx, dz);
  const vertical = dy;
  const distance = Math.hypot(dx, dy, dz);

  const verticalTop = point.y - aabb.max.y;
  const verticalBottom = point.y - aabb.min.y;

  return {
    horizontal,
    vertical,
    distance,
    delta: { dx, dy, dz },
    verticalTop,
    verticalBottom,
  };
}

/**
 * プレイヤー（足元位置）と対象ブロックのAABBとの距離を計算します。
 * ブロックは通常 [x, x+1], [y, y+1], [z, z+1] の1x1x1立方体として扱います。
 *
 * @param player 対象プレイヤー
 * @param block 対象ブロック（Block または Vector3 座標）
 * @returns 水平距離(horizontal)、垂直距離(vertical)、直線距離(distance)を含む計算結果
 */
export function calculatePlayerToBlockDistance(
  player: Player,
  block: Block | Vector3,
): AABBDistanceResult {
  const blockLoc = "location" in block ? block.location : block;

  const aabb: AABB = {
    min: {
      x: blockLoc.x,
      y: blockLoc.y,
      z: blockLoc.z,
    },
    max: {
      x: blockLoc.x + 1,
      y: blockLoc.y + 1,
      z: blockLoc.z + 1,
    },
  };

  return calculatePointToAABBDistance(player.location, aabb);
}
