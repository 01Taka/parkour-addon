import { type Vector3 } from "@minecraft/server";

/** 頻繁に使われる抵抗（流体・粘性）のプリセットキー */
export type DragPreset =
  | "air" // 通常空中 (Y: 0.98, XZ: 0.91)
  | "water" // 水中 (Y: 0.80, XZ: 0.80)
  | "lava" // 溶岩 (Y: 0.50, XZ: 0.50)
  | "cobweb" // クモの巣 (Y: 0.05, XZ: 0.25)
  | "honey" // ハチミツ壁 (Y: 0.20, XZ: 0.20)
  | "ground" // 地上摩擦 (XZ: 0.60)
  | "none"; // 抵抗なし (1.00)

/** 各プリセットの物理数値マップ */
const DRAG_PRESETS: Record<DragPreset, { y: number; xz: number }> = {
  air: { y: 0.98, xz: 0.91 },
  water: { y: 0.8, xz: 0.8 },
  lava: { y: 0.5, xz: 0.5 },
  cobweb: { y: 0.05, xz: 0.25 },
  honey: { y: 0.2, xz: 0.2 },
  ground: { y: 0.98, xz: 0.546 }, // 地上実効保持率 (0.6 * 0.91)
  none: { y: 1.0, xz: 1.0 },
};

/** number または 文字列リテラルから実際の抵抗数値を解決するヘルパー */
function resolveDragValue(
  value: number | DragPreset | undefined,
  axis: "y" | "xz",
): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value in DRAG_PRESETS) {
    return DRAG_PRESETS[value][axis];
  }
  // 指定なし（undefined）時のデフォルト値
  return axis === "y" ? DRAG_PRESETS.air.y : DRAG_PRESETS.air.xz;
}

export interface CalculateVelocityImpulseParams {
  /** 目標とする速度 (null または undefined の軸は制御せず速度を維持) */
  target: { x?: number | null; y?: number | null; z?: number | null };
  /** 現在のエンティティ速度 (player.getVelocity()) */
  current: Vector3;
  /** 経過時間（Tick単位。デフォルト: 1.0） */
  deltaTimeTick?: number;
  /** 追従の鋭さ。デフォルト: 20.0 */
  stiffness?: number;
  /** 1Tickあたりに加算できる最大速度変化量（リミッター） */
  maxAcceleration?: number;

  // --- 物理パラメータ ---
  /**
   * 通常の落下重力（0.08 blocks/tick）を相殺するかどうか。
   * デフォルト: true
   */
  gravity?: boolean;

  /**
   * Y軸の速度維持率（数値 または プリセット文字列）。
   * デフォルト: "air" (0.98)
   */
  dragY?: number | DragPreset;

  /**
   * XZ軸の速度維持率（数値 または プリセット文字列）。
   * デフォルト: "air" (0.91)
   */
  dragXZ?: number | DragPreset;
}

/**
 * 環境の物理特性を逆算し、目標速度に到達するためのインパルスを計算する汎用関数
 */
export function calculateVelocityImpulse({
  target,
  current,
  deltaTimeTick = 1.0,
  stiffness = 20.0,
  maxAcceleration,
  gravity = true,
  dragY = "air",
  dragXZ = "air",
}: CalculateVelocityImpulseParams): Vector3 {
  const GRAVITY_CONSTANT = 0.08;
  const effectiveGravity = gravity ? GRAVITY_CONSTANT : 0.0;

  // 文字列または数値を実際の係数に解決し、ゼロ除算を防止
  const finalDragY = Math.max(0.0001, resolveDragValue(dragY, "y"));
  const finalDragXZ = Math.max(0.0001, resolveDragValue(dragXZ, "xz"));

  // 物理エンジン適用後に目標速度ピッタリになるよう逆算
  let adjustedTargetX =
    target.x !== null && target.x !== undefined ? target.x / finalDragXZ : null;
  let adjustedTargetY =
    target.y !== null && target.y !== undefined
      ? target.y / finalDragY + effectiveGravity
      : null;
  let adjustedTargetZ =
    target.z !== null && target.z !== undefined ? target.z / finalDragXZ : null;

  // deltaTime を考慮した追従率（指数減衰補間）
  const blend = 1.0 - Math.exp(-stiffness * (deltaTimeTick / 20.0));

  // 各軸の差分に追従率を乗算
  let impulseX =
    (adjustedTargetX !== null ? adjustedTargetX - current.x : 0) * blend;
  let impulseY =
    (adjustedTargetY !== null ? adjustedTargetY - current.y : 0) * blend;
  let impulseZ =
    (adjustedTargetZ !== null ? adjustedTargetZ - current.z : 0) * blend;

  // 最大加速度（リミッター）の適用
  if (maxAcceleration !== undefined && maxAcceleration > 0) {
    const length = Math.hypot(impulseX, impulseY, impulseZ);
    if (length > maxAcceleration) {
      const factor = maxAcceleration / length;
      impulseX *= factor;
      impulseY *= factor;
      impulseZ *= factor;
    }
  }

  return { x: impulseX, y: impulseY, z: impulseZ };
}

export interface MaintainVelocityParams {
  /** 現在のエンティティ速度 (player.getVelocity()) */
  current: Vector3;

  /**
   * 通常の落下重力（0.08 blocks/tick）を相殺するかどうか。
   * デフォルト: true
   */
  gravity?: boolean;

  /**
   * Y軸の速度維持率（数値 または プリセット文字列）。
   * デフォルト: "air" (0.98)
   */
  dragY?: number | DragPreset;

  /**
   * XZ軸の速度維持率（数値 または プリセット文字列）。
   * デフォルト: "air" (0.91)
   */
  dragXZ?: number | DragPreset;
}

/**
 * 抵抗や重力の影響を相殺し、現在の速度をそのまま維持するためのインパルスを計算する関数
 */
export function calculateMaintainVelocityImpulse({
  current,
  gravity = true,
  dragY = "air",
  dragXZ = "air",
}: MaintainVelocityParams): Vector3 {
  const GRAVITY_CONSTANT = 0.08;
  const effectiveGravity = gravity ? GRAVITY_CONSTANT : 0.0;

  // 抵抗係数の解決とゼロ除算防止
  const finalDragY = Math.max(0.0001, resolveDragValue(dragY, "y"));
  const finalDragXZ = Math.max(0.0001, resolveDragValue(dragXZ, "xz"));

  // 物理エンジン適用後に current と全く同じ値になるインパルス
  return {
    x: current.x * (1.0 / finalDragXZ - 1.0),
    y: current.y * (1.0 / finalDragY - 1.0) + effectiveGravity,
    z: current.z * (1.0 / finalDragXZ - 1.0),
  };
}
