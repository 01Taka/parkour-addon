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
export const DRAG_PRESETS: Record<DragPreset, { y: number; xz: number }> = {
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
  /** 追従の鋭さ。nullの場合は即座に目標速度に到達（blend = 1.0）。デフォルト: null */
  stiffness?: number | null;
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
  stiffness = null,
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

  // deltaTime を考慮した追従率（指数減衰補間）。stiffness が null の場合は 1.0（即座に到達）
  const blend =
    stiffness === null
      ? 1.0
      : 1.0 - Math.exp(-stiffness * (deltaTimeTick / 20.0));

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

/**
 * 指定したブロック数分浮き上がるのに必要なインパルスベクトルを計算します。
 * 近似式: v0 ≈ √(0.165 * H) + 0.05 * H^0.7
 *
 * @param targetHeight 浮き上がりたいブロック数 (H > 0)
 * @param currentVelocity 現在のエンティティのベロシティ (player.getVelocity())
 * @returns applyImpulse に渡すインパルスベクトル
 */
export function calculateLiftImpulse(
  targetHeight: number,
  currentVelocity: Vector3 = { x: 0, y: 0, z: 0 },
): Vector3 {
  if (targetHeight <= 0) {
    return { x: 0, y: 0, z: 0 };
  }

  // 1. 目標高度に到達するために必要な垂直初速度 v0 を計算
  const targetVy =
    Math.sqrt(0.165 * targetHeight) + 0.05 * Math.pow(targetHeight, 0.7);

  // 2. applyImpulse は現在の速度に加算されるため、差分を計算
  // (落下中なら落下を相殺する分がプラスされ、上昇中なら小さくなります)
  const impulseY = targetVy - currentVelocity.y;

  // 水平方向は維持するため X, Z は 0
  return {
    x: 0,
    y: impulseY,
    z: 0,
  };
}

export interface LiftImpulseResult {
  /** applyImpulse に渡すインパルスベクトル */
  impulse: Vector3;
  /** 最高高度（目標高度）に達するまでの経過Tick数 (整数) */
  ticksToApex: number;
  /** 最高高度に達するまでの秒数 (ticks / 20) */
  timeToApexSeconds: number;
  /** 算出された垂直初速度 v0 (blocks/tick) */
  initialVelocityY: number;
}

/**
 * 目標高度に必要な初速度と、最高点に達するまでのTick数を同時にシミュレーションして逆算します。
 */
function solveLiftPhysics(targetHeight: number): {
  initialVy: number;
  ticks: number;
} {
  if (targetHeight <= 0) return { initialVy: 0, ticks: 0 };

  let low = 0;
  let high = targetHeight * 0.8 + 2.0;

  // 1. 初速度 v0 を二分探索で特定
  for (let i = 0; i < 25; i++) {
    const mid = (low + high) / 2;
    let v = mid;
    let h = 0;

    while (true) {
      v -= 0.08;
      if (v <= 0) break;
      h += v;
      v *= 0.98;
    }

    if (h < targetHeight) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const initialVy = (low + high) / 2;

  // 2. 確定した初速度で実機パイプラインを1回走らせ、最高点までのTick数をカウント
  let v = initialVy;
  let ticks = 0;
  while (true) {
    v -= 0.08;
    if (v <= 0) break; // 上昇が止まり落下に転じた瞬間
    ticks++;
    v *= 0.98;
  }

  return { initialVy, ticks };
}

/**
 * 指定したブロック数分浮き上がるのに必要なインパルスと、最高点到達までの時間を計算します。
 *
 * @param targetHeight 浮き上がりたいブロック数 (H > 0)
 * @param currentVelocity 現在のエンティティのベロシティ (player.getVelocity())
 */
export function calculateLiftImpulseAccurate(
  targetHeight: number,
  currentVelocity: Vector3 = { x: 0, y: 0, z: 0 },
): LiftImpulseResult {
  if (targetHeight <= 0) {
    return {
      impulse: { x: 0, y: 0, z: 0 },
      ticksToApex: 0,
      timeToApexSeconds: 0,
      initialVelocityY: 0,
    };
  }

  // 1. 初速度とTick数を計算
  const { initialVy, ticks } = solveLiftPhysics(targetHeight);

  // 2. 現在の速度との差分をインパルスとする
  const impulseY = initialVy - currentVelocity.y;

  return {
    impulse: { x: 0, y: impulseY, z: 0 },
    ticksToApex: ticks,
    timeToApexSeconds: ticks / 20.0,
    initialVelocityY: initialVy,
  };
}

/**
 * nティックかけて指定した高さ(H)分上昇するのに必要な初速度(インパルス)を計算
 *
 * @param nTick 上昇にかけるTick数 (n >= 1)
 * @param targetHeight 上昇したいブロック数 (デフォルト: 1.0)
 */
export function calculateImpulseForNTicks(
  nTick: number,
  targetHeight: number = 1.0,
): number {
  if (nTick <= 0) return 0;

  // v0 = (0.02 * H + 0.08 * n) / (1 - 0.98^n) - 3.92
  const numerator = 0.02 * targetHeight + 0.08 * nTick;
  const denominator = 1.0 - Math.pow(0.98, nTick);

  return numerator / denominator - 3.92;
}
