import {
  Block,
  Direction,
  world,
  system,
  type Player,
  type Vector3,
} from "@minecraft/server";
import { parkourEventHandler } from "../utils/parkour-event-handler.class";
import { calculatePlayerToBlockDistance } from "../utils/positional.utils";
import { calculateVelocityImpulse } from "../utils/impulse.utils";
import {
  hasBlockCollisionFromAirFaces,
  hasBlockCollisionFromFace,
} from "../utils/collision.utils";

// ==========================================
// 定数・パラメータ設定
// ==========================================

/**
 * Minecraftの垂直物理実効重力定数
 * バニラジャンプ (初速 0.42 で最高到達高度 1.25m) より:
 * H = v^2 / (2 * g_eff) => g_eff = 0.42^2 / (2 * 1.25) ≈ 0.07056
 */
const EFFECTIVE_GRAVITY = 0.071;

/** ブロック上面を超えるマージン高さ（確実に上面に乗るための余裕） */
export const CLIMB_HEIGHT_MARGIN = 0.18;

/** 目標垂直初速度の最小値（浅い段差でもスムーズに登るための下限） */
export const MIN_TARGET_VELOCITY_Y = 0.28;

/** 目標垂直初速度の最大値（安全リミッター: -1.6mからの登りあがりにも対応） */
export const MAX_TARGET_VELOCITY_Y = 0.55;

/** 側面ヒット時の verticalTop 許容下限 */
export const CLIMB_SIDE_MIN_VERTICAL_TOP = -1.0;

/** 上面ヒット時の verticalTop 許容下限 */
export const CLIMB_TOP_MIN_VERTICAL_TOP = -1.6;

/** verticalTopの許容上限（共通: 0以下） */
export const CLIMB_MAX_VERTICAL_TOP = 0;

/** ヒットブロックとの最大水平距離 */
export const CLIMB_MAX_HORIZONTAL_DISTANCE = 0.9;

/** Y方向許容速度範囲 */
export const CLIMB_MIN_VELOCITY_Y = -0.6;
export const CLIMB_MAX_VELOCITY_Y = 0.3;

/** のぼりあがり時の前方目標水平速度 (ブロック/tick) */
export const CLIMB_FORWARD_SPEED = 0.22;

/** のぼりあがり発動済みプレイヤーID（着地するまで再発動不可） */
const hasUsedClimb = new Set<string>();

// ==========================================
// 数学・物理計算ロジック
// ==========================================

/**
 * ブロック上面まで登りきるために必要な目標垂直初速度(targetVelocityY)を、
 * 物理エネルギー保存則（最高到達高度 H = v^2 / (2 * g_eff)）から逆算します。
 *
 * @param verticalTop ブロック上面からの垂直距離 (-1.6 <= verticalTop < 0)
 * @returns 登りきるために必要な目標垂直初速度 (ブロック/tick)
 */
export function calculateTargetVelocityY(verticalTop: number): number {
  // 必要上昇量: ブロック上面までの差分 (-verticalTop) + マージン
  const requiredHeight = Math.max(0.1, -verticalTop + CLIMB_HEIGHT_MARGIN);

  // v = sqrt(2 * g_eff * H)
  const theoreticalVel = Math.sqrt(2 * EFFECTIVE_GRAVITY * requiredHeight);

  // 最小値〜最大値の範囲にクランプ
  return Math.min(
    MAX_TARGET_VELOCITY_Y,
    Math.max(MIN_TARGET_VELOCITY_Y, theoreticalVel),
  );
}

// ==========================================
// アクション判定・実行
// ==========================================

/**
 * のぼりあがりアクションを実行します。
 */
export function executeClimbUp(
  player: Player,
  verticalTop: number,
  currentVel: Vector3,
): void {
  // 視線方向の水平成分を取得して前進目標速度を決定
  const viewDir = player.getViewDirection();
  const horizLen = Math.hypot(viewDir.x, viewDir.z);
  const forwardX =
    horizLen > 0 ? (viewDir.x / horizLen) * CLIMB_FORWARD_SPEED : 0;
  const forwardZ =
    horizLen > 0 ? (viewDir.z / horizLen) * CLIMB_FORWARD_SPEED : 0;

  // 登りきるために必要な目標垂直速度を物理エネルギーから算出
  const targetVelY = calculateTargetVelocityY(verticalTop);

  // calculateVelocityImpulse を通して重力(0.08)と空気抵抗(0.98)を相殺し、
  // 現在の落下速度に関わらず確実に targetVelY に達するインパルスを計算
  const impulse = calculateVelocityImpulse({
    target: {
      x: forwardX,
      y: targetVelY,
      z: forwardZ,
    },
    current: currentVel,
    dragY: "air",
    dragXZ: "air",
  });

  player.applyImpulse(impulse);
  hasUsedClimb.add(player.id);
}

/**
 * のぼりあがりの発動可否を判定し、条件を満たす場合アクションを実行します。
 * コストが低く不発頻度が高い判定から順に評価して早期リターンします。
 */
export function tryClimbUp(
  player: Player,
  hitBlock: Block,
  hitFace: Direction,
): void {
  // 1. 接地判定（最頻出かつプロパティ参照のみで最軽量）
  if (player.isOnGround) return;

  // 2. 空中での多重発動防止（Setの高速ルックアップ）
  if (hasUsedClimb.has(player.id)) return;

  // 3. 対象外ヒット面（下面ヒットは登り不可）
  if (hitFace === Direction.Down) return;

  // 4. Y方向の速度判定（位置計算前に除外）
  const vel = player.getVelocity();
  if (vel.y < CLIMB_MIN_VELOCITY_Y || vel.y > CLIMB_MAX_VELOCITY_Y) return;

  // 5. ブロックとの距離・高さ判定
  const { horizontal, verticalTop } = calculatePlayerToBlockDistance(
    player,
    hitBlock.location,
  );

  // 5-1. 水平距離
  if (horizontal > CLIMB_MAX_HORIZONTAL_DISTANCE) return;

  // 5-2. 垂直位置の共通範囲チェック
  if (
    verticalTop < CLIMB_TOP_MIN_VERTICAL_TOP ||
    verticalTop > CLIMB_MAX_VERTICAL_TOP
  ) {
    return;
  }

  // 6. 殴ったブロック自体の固体（当たり判定）判定
  if (!hasBlockCollisionFromFace(hitBlock, hitFace)) return;

  // 7. ヒット面別の判定
  if (hitFace !== Direction.Up) {
    // 側面ヒット時: -1.0 以上であること
    if (verticalTop < CLIMB_SIDE_MIN_VERTICAL_TOP) return;

    // 側面ヒット時のみ: 直上のブロックが透過（通り抜け可能）か判定（レイキャストを伴うため最深部で評価）
    if (hasBlockCollisionFromAirFaces(hitBlock.above(1))) return;
  }

  // すべての条件を満たした場合に登りあがりを実行
  executeClimbUp(player, verticalTop, vel);
}

// ==========================================
// メイン初期化
// ==========================================

export function climbingMain() {
  // 1. 着地監視ループ（着地したら再発動フラグを解除）
  system.runInterval(() => {
    if (hasUsedClimb.size === 0) return;

    for (const player of world.getAllPlayers()) {
      if (!player.isValid || player.isOnGround) {
        hasUsedClimb.delete(player.id);
      }
    }
  }, 1);

  // 2. ブロック殴打イベント購読
  parkourEventHandler.onHitBlock.subscribe(({ player, hitBlock, hitFace }) => {
    tryClimbUp(player, hitBlock, hitFace);
  });

  // 3. プレイヤー切断時のクリーンアップ
  world.afterEvents.playerLeave.subscribe((event) => {
    hasUsedClimb.delete(event.playerId);
  });
}
