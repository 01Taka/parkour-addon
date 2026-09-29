import {
  world,
  system,
  Player,
  Block,
  Direction,
  type Vector3,
} from "@minecraft/server";
import { parkourEventHandler } from "../classes/parkour-event-handler.class";
import { hasBlockCollisionFromFace } from "../utils/collision.utils";
import { calculateLiftImpulseAccurate } from "../utils/physics.utils";

// ==========================================
// 定数・パラメータ設定
// ==========================================

/**
 * ヴォルト発動時の目標浮き上がり高さ（ブロック数）
 */
export const VOLT_TARGET_HEIGHT = 1.05;

/** ヴォルト発動時の前方（ブロック方向）インパルス強度 */
export const VOLT_IMPULSE_FORWARD = 0.2;

/** 再度発動可能になるまでのクールダウン（tick） */
export const VOLT_COOLDOWN_TICKS = 1;

// ==========================================
// 状態管理
// ==========================================

interface VoltState {
  /** 次に再発動可能になるtick */
  canTriggerAfterTick: number;
}

const voltStates = new Map<string, VoltState>();

// ==========================================
// アクション判定・実行
// ==========================================

/**
 * ヴォルトのインパルス（対象ブロック方向の斜め上）をプレイヤーに付与します。
 *
 * @param player 対象プレイヤー
 * @param hitBlock 殴打された対象ブロック
 */
export function applyVoltImpulse(player: Player, hitBlock: Block): void {
  // プレイヤーからブロックの中心への水平方向ベクトルを算出
  const blockCenterX = hitBlock.location.x + 0.5;
  const blockCenterZ = hitBlock.location.z + 0.5;

  const dx = blockCenterX - player.location.x;
  const dz = blockCenterZ - player.location.z;
  const horizLen = Math.hypot(dx, dz);

  const forwardX = horizLen > 0 ? (dx / horizLen) * VOLT_IMPULSE_FORWARD : 0;
  const forwardZ = horizLen > 0 ? (dz / horizLen) * VOLT_IMPULSE_FORWARD : 0;

  // 指定したブロック数分浮き上がるための垂直インパルスを計算
  const liftImpulse = calculateLiftImpulseAccurate(
    VOLT_TARGET_HEIGHT,
    player.getVelocity(),
  );

  const impulse: Vector3 = {
    x: forwardX,
    y: liftImpulse.impulse.y,
    z: forwardZ,
  };

  // pk-roll と同様に system.run 経由で安全にインパルスを適用
  system.run(() => {
    if (!player.isValid) return;
    player.applyImpulse(impulse);
  });
}

/**
 * ヴォルトの発動可否を判定し、条件を満たす場合にアクションを実行します。
 *
 * 発動条件:
 * 1. プレイヤーの地面が脚についている（isOnGround）こと
 * 2. ブロックの側面を殴ったこと（hitFace が Up / Down 以外）
 * 3. クールダウンが経過していること
 * 4. 殴ったブロックに当たり判定があること
 */
export function tryTriggerVolt(
  player: Player,
  hitBlock: Block,
  hitFace: Direction,
): boolean {
  const currentTick = system.currentTick;
  const state = voltStates.get(player.id);

  // 1. 地面が脚についている状態（接地状態）であること
  if (!player.isOnGround) {
    return false;
  }

  // 2. ブロックの側面（North, South, East, West）であること
  if (hitFace === Direction.Up || hitFace === Direction.Down) {
    return false;
  }

  // 3. クールダウン判定
  if (state && currentTick < state.canTriggerAfterTick) {
    return false;
  }

  // 4. 殴ったブロックの当たり判定チェック（草や花などのすり抜けブロックは除外）
  if (!hasBlockCollisionFromFace(hitBlock, hitFace)) {
    return false;
  }

  // クールダウン設定
  voltStates.set(player.id, {
    canTriggerAfterTick: currentTick + VOLT_COOLDOWN_TICKS,
  });

  // 斜め上（ブロック方向）へのインパルスを付与
  applyVoltImpulse(player, hitBlock);

  return true;
}

// ==========================================
// メイン初期化
// ==========================================

export function voltMain(): void {
  // ブロック殴打イベント購読
  parkourEventHandler.onHitBlock.subscribe(({ player, hitBlock, hitFace }) => {
    tryTriggerVolt(player, hitBlock, hitFace);
  });

  // プレイヤー切断時のクリーンアップ
  world.afterEvents.playerLeave.subscribe((event) => {
    voltStates.delete(event.playerId);
  });
}
