import {
  world,
  system,
  InputButton,
  ButtonState,
  Player,
  type Vector3,
} from "@minecraft/server";
import { calculateVelocityImpulse } from "./impulse.utils";
import { calculatePlayerToBlockDistance } from "./positional.utils";
import { parkourEventHandler } from "./parkour-event-handler.class";

/** スライディング時に加算する速度 (ブロック/tick) */
export const SLIDE_ADDITIONAL_SPEED = 0.25;

/** スライディングの持続時間 (Tick数。20 ticks = 1秒) */
export const SLIDE_DURATION_TICKS = 15;

/** スライディングを発動するために必要な最小水平速度 */
export const MIN_SPEED_TO_SLIDE = 0.05;

/** スライディング中に空中にいる場合、斜面に沿わせるための下方向追加インパルス (ブロック/tick) */
export const SLIDE_DOWNWARD_IMPULSE = 0.2;

/** スライディングの段階・フェーズ（アニメーション等の分岐用） */
export type SlidePhase = "sliding" | "slide_jump";

interface SlidingState {
  phase: SlidePhase;
  targetVelocity: { x: number; z: number };
  remainingTicks: number;
  /** スライディングジャンプ中に空中に離陸したかどうかのフラグ */
  hasLeftGround?: boolean;
}

const activeSlides = new Map<string, SlidingState>();

/**
 * プレイヤーがスライディング（またはスライディングジャンプ）中であるかを判定します。
 */
export function isSliding(playerId: string): boolean {
  return activeSlides.has(playerId);
}

/**
 * 殴ったブロックが足元（足元から2m以内かつ足元〜その1マス下）であるか判定します。
 */
function isGroundBlock(player: Player, blockLoc: Vector3): boolean {
  const { distance, signedVertical } = calculatePlayerToBlockDistance(
    player,
    blockLoc,
  );

  // y座標が足元〜その一マス下のブロック (0 <= signedVertical <= 1.0)
  const isYValid = signedVertical >= 0 && signedVertical <= 1.0;

  return isYValid && distance <= 2.0;
}

/**
 * プレイヤーのスライディング処理を開始します。
 */
function tryStartSliding(player: Player): void {
  // 既にスライディングまたはスライディングジャンプ中の場合は多重発動しない
  if (activeSlides.has(player.id)) {
    return;
  }

  const currentVelocity = player.getVelocity();
  const horizontalSpeed = Math.hypot(currentVelocity.x, currentVelocity.z);

  // 速度が十分でない（ほぼ静止している）場合はスライディングを開始しない
  if (horizontalSpeed < MIN_SPEED_TO_SLIDE) {
    return;
  }

  // スライディング開始時点の進行方向単位ベクトル
  const dirX = currentVelocity.x / horizontalSpeed;
  const dirZ = currentVelocity.z / horizontalSpeed;

  // 目標速度 = 現在の速度 + 一定速度
  const targetSpeed = horizontalSpeed + SLIDE_ADDITIONAL_SPEED;

  activeSlides.set(player.id, {
    phase: "sliding",
    targetVelocity: {
      x: dirX * targetSpeed,
      z: dirZ * targetSpeed,
    },
    remainingTicks: SLIDE_DURATION_TICKS,
  });
}

/**
 * スライディング機能の初期化・メインループを開始します。
 */
export function slidingMain(): void {
  // 1. 毎Tickごとの移動更新ループ
  system.runInterval(() => {
    if (activeSlides.size === 0) return;

    for (const player of world.getAllPlayers()) {
      const slideState = activeSlides.get(player.id);
      if (!slideState) continue;

      if (!player.isValid) {
        activeSlides.delete(player.id);
        continue;
      }

      // calculateVelocityImpulse を使用してインパルスを計算
      // y軸の移動は無視するため target.y に null を指定
      const impulse = calculateVelocityImpulse({
        target: {
          x: slideState.targetVelocity.x,
          y: null,
          z: slideState.targetVelocity.z,
        },
        current: player.getVelocity(),
        dragXZ: player.isOnGround ? "ground" : "air",
      });

      // フェーズごとの持続時間・終了判定
      if (slideState.phase === "sliding") {
        // 通常スライディング: 空中にいる間はタイマーをリセットして持続時間を延長
        if (!player.isOnGround) {
          slideState.remainingTicks = SLIDE_DURATION_TICKS;
          // 通常スライディング中に空中にいる場合、斜面に沿わせるため下方向の追加インパルスを付与
          impulse.y -= SLIDE_DOWNWARD_IMPULSE;
        } else {
          slideState.remainingTicks -= 1;
          if (slideState.remainingTicks <= 0) {
            activeSlides.delete(player.id);
            continue;
          }
        }
      } else if (slideState.phase === "slide_jump") {
        // スライディングジャンプ: 空中に離陸したのち、地面に着地した時点で終了
        if (!player.isOnGround) {
          slideState.hasLeftGround = true;
        } else if (slideState.hasLeftGround) {
          activeSlides.delete(player.id);
          continue;
        }

        // 安全タイマー（着地しない状態が続いた場合のタイムアウト）
        slideState.remainingTicks -= 1;
        if (slideState.remainingTicks <= -100) {
          activeSlides.delete(player.id);
          continue;
        }
      }

      player.applyImpulse(impulse);
    }
  }, 1);

  // 2. ブロック殴打イベント購読によるスライディング発動（素手または銅の剣で地面を殴った時）
  parkourEventHandler.onHitBlock.subscribe((event) => {
    if (isGroundBlock(event.player, event.hitBlock.location)) {
      tryStartSliding(event.player);
    }
  });

  // 3. スライディング中のジャンプ入力（スライディングジャンプへ移行）
  try {
    world.afterEvents.playerButtonInput.subscribe((event) => {
      if (
        event.button === InputButton.Jump &&
        event.newButtonState === ButtonState.Pressed
      ) {
        const slideState = activeSlides.get(event.player.id);
        if (slideState && slideState.phase === "sliding") {
          slideState.phase = "slide_jump";
          slideState.hasLeftGround = false;
        }
      }
    });
  } catch (e) {
    console.warn("playerButtonInput subscription failed:", e);
  }

  // 4. プレイヤー切断時のクリーンアップ
  world.afterEvents.playerLeave.subscribe((event) => {
    activeSlides.delete(event.playerId);
  });
}
