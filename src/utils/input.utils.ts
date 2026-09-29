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

  // Minecraft の raw.x は左が正(+)、右が負(-)のため、-vec.x で反転して「右を正(+)、左を負(-)」として計算
  return Math.atan2(-vec.x, vec.y);
}
