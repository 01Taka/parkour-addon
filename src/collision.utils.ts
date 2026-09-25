import {
  Block,
  type Vector3,
  type BlockRaycastOptions,
  type BlockRaycastHit,
} from "@minecraft/server";

/**
 * ブロックの中心（Y: 0.01 → 0.99）を貫くレイキャストで、通り抜けるかを単一処理で判定する
 * @param block 判定対象のブロック
 * @returns 当たり判定があれば true、通り抜けられるなら false
 */
export function hasBlockCollision(block: Block | undefined): boolean {
  // 空気や液体はレイキャストするまでもなく当たり判定なし
  if (!block || block.isAir || block.isLiquid) {
    return false;
  }

  const { x, y, z } = block.location;

  // ブロック底面からわずか0.01上（中心軸）を始点にし、天面手前0.99まで上向きに照射
  const startLocation: Vector3 = { x: x + 0.5, y: y + 0.01, z: z + 0.5 };
  const direction: Vector3 = { x: 0, y: 1, z: 0 };
  const maxDistance: number = 0.98; // 0.01 + 0.98 = 0.99（上のブロック境界 1.0 に届かない）

  const options: BlockRaycastOptions = {
    maxDistance: maxDistance,
    includePassableBlocks: false, // 草・花・松明などのすり抜け可能ブロックは除外
    includeLiquidBlocks: false, // 水や溶岩も除外
  };

  const hit: BlockRaycastHit | undefined = block.dimension.getBlockFromRay(
    startLocation,
    direction,
    options,
  );

  // 衝突したブロックが判定対象のブロック座標と一致していれば当たり判定あり
  return (
    hit !== undefined &&
    hit.block.location.x === x &&
    hit.block.location.y === y &&
    hit.block.location.z === z
  );
}
