import {
  Block,
  Direction,
  world,
  system,
  type Player,
  type Vector3,
} from "@minecraft/server";
import { parkourEventHandler } from "./parkour-event-handler.class";
import { calculatePlayerToBlockDistance } from "./positional.utils";
import { calculateVelocityImpulse } from "./impulse.utils";
import { hasBlockCollision } from "./collision.utils";

// ==========================================
// 定数・パラメータ設定
// ==========================================

/**
 * Minecraftの垂直物理実効重力定数
 * バニラジャンプ (初速 0.42 で最高到達高度 1.25m) より:
 * H = v^2 / (2 * g_eff) => g_eff = 0.42^2 / (2 * 1.25) ≈ 0.07056
 */
const EFFECTIVE_GRAVITY = 0.071;

/** ブロック上面を超えるマージン高さ（確実に上面に乗るための余裕。0.15〜0.2m） */
export const CLIMB_HEIGHT_MARGIN = 0.18;

/** 目標垂直初速度の最小値（浅い段差でもスムーズに登るための下限） */
export const MIN_TARGET_VELOCITY_Y = 0.28;

/** 側面ヒット時の verticalTop 許容下限 */
export const CLIMB_SIDE_MIN_VERTICAL_TOP = -1.0;

/** 上面ヒット時の verticalTop 許容下限 */
export const CLIMB_TOP_MIN_VERTICAL_TOP = -1.6;

/** verticalTopの許容上限（共通: 0以下） */
export const CLIMB_MAX_VERTICAL_TOP = 0;

/** 目標垂直初速度の最大値（安全リミッター: -1.6mからの登りあがりにも対応） */
export const MAX_TARGET_VELOCITY_Y = 0.55;

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
 * のぼりあがりの発動可否を判定し、条件を満たさない理由の一覧を返します。
 * 配列が空であれば発動条件を満たしています。
 */
export function getClimbUpFailReasons(
  player: Player,
  hitBlock: Block,
  hitFace: Direction,
  horizontal: number,
  verticalTop: number,
  vel: Vector3,
): string[] {
  const reasons: string[] = [];

  // すでに空中で登りあがり済みの場合、着地するまで再発動不可
  if (hasUsedClimb.has(player.id)) {
    reasons.push("未着地(クール中)");
  }

  // ヒットしたブロックとのxz距離(horizontal)が0.9以内
  if (horizontal > 0.9) {
    reasons.push(`hor距離(${horizontal.toFixed(2)} > 0.9)`);
  }

  // ブロックの側面かつverticalTop が-1以上 || ブロックの上面かつverticalTop が-1.6以上（0以下は共通）
  const isTopFace = hitFace === Direction.Up;
  const isSideFace =
    hitFace === Direction.North ||
    hitFace === Direction.South ||
    hitFace === Direction.East ||
    hitFace === Direction.West;

  if (verticalTop > CLIMB_MAX_VERTICAL_TOP) {
    reasons.push(
      `verTop超過(${verticalTop.toFixed(2)} > ${CLIMB_MAX_VERTICAL_TOP})`,
    );
  } else if (isTopFace) {
    if (verticalTop < CLIMB_TOP_MIN_VERTICAL_TOP) {
      reasons.push(
        `上面verTop(${verticalTop.toFixed(2)}: ${CLIMB_TOP_MIN_VERTICAL_TOP}〜${CLIMB_MAX_VERTICAL_TOP})`,
      );
    }
  } else if (isSideFace) {
    if (verticalTop < CLIMB_SIDE_MIN_VERTICAL_TOP) {
      reasons.push(
        `側面verTop(${verticalTop.toFixed(2)}: ${CLIMB_SIDE_MIN_VERTICAL_TOP}〜${CLIMB_MAX_VERTICAL_TOP})`,
      );
    }

    // 側面ヒット時: 対象ブロックの上のブロックが透過ブロックであることを確認
    if (hasBlockCollision(hitBlock.above(1))) {
      const aboveType = hitBlock.above(1)?.typeId ?? "unknown";
      reasons.push(`直上ブロック非透過(${aboveType})`);
    }
  } else {
    reasons.push(`対象外ヒット面(${hitFace})`);
  }

  // 地面に足がついていない
  if (player.isOnGround) {
    reasons.push("接地中");
  }

  // y方向の速度が-0.6以上0.3以下
  if (vel.y < -0.6 || vel.y > 0.3) {
    reasons.push(`y速度(${vel.y.toFixed(2)})`);
  }

  return reasons;
}

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

  // インパルスを適用
  player.applyImpulse(impulse);

  // 空中での多重発動を防止
  hasUsedClimb.add(player.id);
  player.sendMessage("§a[Climb] のぼりあがり");
}

// ==========================================
// メイン初期化
// ==========================================

export function climbingMain() {
  // 1. 着地監視ループ（着地したら再発動フラグを解除）
  system.runInterval(() => {
    if (hasUsedClimb.size === 0) return;

    for (const player of world.getAllPlayers()) {
      if (!player.isValid) {
        hasUsedClimb.delete(player.id);
        continue;
      }

      if (player.isOnGround) {
        hasUsedClimb.delete(player.id);
      }
    }
  }, 1);

  // 2. ブロック殴打イベント購読
  parkourEventHandler.onHitBlock.subscribe(({ player, hitBlock, hitFace }) => {
    const { distance, horizontal, verticalTop } =
      calculatePlayerToBlockDistance(player, hitBlock.location);
    const vel = player.getVelocity();

    // テスト用メッセージ
    player.sendMessage(
      `dis: ${distance.toFixed(2)}, hor: ${horizontal.toFixed(2)},  ver: ${verticalTop.toFixed(2)}, y: ${vel.y.toFixed(2)}, (${vel.x.toFixed(2)}, ${vel.z.toFixed(2)})`,
    );

    // 1. のぼりあがり判定と理由出力
    const failReasons = getClimbUpFailReasons(
      player,
      hitBlock,
      hitFace,
      horizontal,
      verticalTop,
      vel,
    );

    if (failReasons.length === 0) {
      executeClimbUp(player, verticalTop, vel);
    } else {
      player.sendMessage(`§c[Climb NG] ${failReasons.join(", ")}`);
    }
  });

  // 3. プレイヤー切断時のクリーンアップ
  world.afterEvents.playerLeave.subscribe((event) => {
    hasUsedClimb.delete(event.playerId);
  });
}
