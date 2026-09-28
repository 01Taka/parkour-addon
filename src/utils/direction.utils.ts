import type { Vector3 } from "@minecraft/server";

type Vec2 = { x: number; z: number };

// 2次元AABBの定義
type AABB2D = {
  min: Vec2; // 最小点 (minX, minZ)
  max: Vec2; // 最大点 (maxX, maxZ)
};

export function getNearestFaceDirection(vec: Vec2): Vector3 {
  const absX = Math.abs(vec.x);
  const absZ = Math.abs(vec.z);

  if (absX === 0 && absZ === 0) {
    return { x: 0, y: 0, z: 0 };
  }

  if (absX >= absZ) {
    return { x: Math.sign(vec.x), y: 0, z: 0 };
  } else {
    return { x: 0, y: 0, z: Math.sign(vec.z) };
  }
}

/**
 * ベクトルの向きに一番近いAABBの面（辺）の両端の座標を返す
 * @param aabb 対象のAABB
 * @param vec 方向ベクトル
 * @param shrink AABBを内側に縮小する量（デフォルト: 0）
 */
export function getNearestFaceSegment(
  aabb: AABB2D,
  vec: Vec2,
  shrink: number = 0,
): [Vec2, Vec2] | [] {
  const dir = getNearestFaceDirection(vec);

  if (dir.x === 0 && dir.z === 0) {
    return [];
  }

  // 縮小後の境界座標を計算
  const minX = aabb.min.x + shrink;
  const maxX = aabb.max.x - shrink;
  const minZ = aabb.min.z + shrink;
  const maxZ = aabb.max.z - shrink;

  if (dir.x > 0) {
    // +X 面
    return [
      { x: maxX, z: minZ },
      { x: maxX, z: maxZ },
    ];
  } else if (dir.x < 0) {
    // -X 面
    return [
      { x: minX, z: minZ },
      { x: minX, z: maxZ },
    ];
  } else if (dir.z > 0) {
    // +Z 面
    return [
      { x: minX, z: maxZ },
      { x: maxX, z: maxZ },
    ];
  } else {
    // -Z 面
    return [
      { x: minX, z: minZ },
      { x: maxX, z: minZ },
    ];
  }
}
