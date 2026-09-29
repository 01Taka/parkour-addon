import { Block, Player, type Vector2, type Vector3 } from "@minecraft/server";
import {
  calculatePointToAABBDistance,
  type AABB,
  type AABBDistanceResult,
} from "./geometry.utils";

/**
 * プレイヤーのワールド座標系 AABB（境界ボックス）を取得します。
 * スニーク、泳ぎ、エリトラ滑空、睡眠などの姿勢変化に対応しています。
 *
 * @param player 対象のプレイヤー
 * @returns 最小座標 (min) と 最大座標 (max)
 */
export function getPlayerAABB(player: Player): AABB {
  const rawAABB = player.getAABB();
  const { center, extent } = rawAABB;
  return {
    min: {
      x: center.x - extent.x,
      y: center.y - extent.y,
      z: center.z - extent.z,
    },
    max: {
      x: center.x + extent.x,
      y: center.y + extent.y,
      z: center.z + extent.z,
    },
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

/**
 * プレイヤーの移動入力が前方に対して何ラジアン傾いているかを返します。
 *
 * @param target Player オブジェクト、または Vector2 ({ x, y })
 * @returns 前方を 0 としたラジアン値（-π 〜 +π）。入力がない場合は null。
 */
export function getMovementInputAngle(target: Player | Vector2): number | null {
  // Player が渡された場合は inputInfo からベクトルを取得
  const vec: Vector2 =
    target instanceof Player ? target.inputInfo.getMovementVector() : target;

  // 入力がない（静止状態）の場合は判定不能なため null を返す
  if (vec.x === 0 && vec.y === 0) {
    return null;
  }

  // Minecraft の raw.x は左が正(+)、右が負(-)のため、-vec.x で反転して「右を正(+)、左を負(-)」として計算
  return Math.atan2(-vec.x, vec.y);
}
