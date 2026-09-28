import { Player, type Vector2 } from "@minecraft/server";

/**
 * プレイヤーの移動入力が前方に対して何ラジアン傾いているかを返します。
 *
 * @param target Player オブジェクト、または Vector2 ({ x, y })
 * @returns 前方を 0 としたラジアン値（-π 〜 +π）。入力がない場合は null。
 *
 */
export function getMovementInputAngle(target: Player | Vector2): number | null {
  // Player が渡された場合は inputInfo からベクトルを取得
  const vec: Vector2 =
    target instanceof Player ? target.inputInfo.getMovementVector() : target;

  // 入力がない（静止状態）の場合は判定不能なため null を返す
  if (vec.x === 0 && vec.y === 0) {
    return null;
  }

  // 前方 (0, 1) を基準とし、右を正(+)、左を負(-)とするラジアンを計算
  return Math.atan2(vec.x, vec.y);
}
