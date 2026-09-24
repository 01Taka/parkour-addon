import {
  world,
  system,
  InputButton,
  ButtonState,
  EquipmentSlot,
  Player,
  type Vector3,
} from "@minecraft/server";
import { calculateVelocityImpulse } from "./impulse.utils";

/** プレイヤーのメインハンドにアイテムを持っていない（素手）か判定 */
function isMainHandEmpty(player: Player): boolean {
  const equippable = player.getComponent("minecraft:equippable");
  if (equippable) {
    return equippable.getEquipment(EquipmentSlot.Mainhand) === undefined;
  }
  const inv = player.getComponent("minecraft:inventory");
  if (inv?.container) {
    return inv.container.getItem(player.selectedSlotIndex) === undefined;
  }
  return true;
}

/** スライディング時に加算する速度 (ブロック/tick) */
export const SLIDE_ADDITIONAL_SPEED = 0.25;

/** スライディングの持続時間 (Tick数。20 ticks = 1秒) */
export const SLIDE_DURATION_TICKS = 15;

/** スライディングを発動するために必要な最小水平速度 */
export const MIN_SPEED_TO_SLIDE = 0.05;

/** 地上にいる場合のみスライディングを許可するかどうか */
export const REQUIRE_ON_GROUND = true;

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
 * 破壊しようとしているブロックがスライディング発動条件（足元から2m以内かつ足元〜その1マス下）を満たしているか判定します。
 */
function isValidBreakTarget(player: Player, blockLoc: Vector3): boolean {
  const playerLoc = player.location;
  const playerFootY = Math.floor(playerLoc.y);

  // y座標が足元〜その一マス下のブロック
  if (blockLoc.y !== playerFootY && blockLoc.y !== playerFootY - 1) {
    return false;
  }

  // プレイヤー足元位置からブロックAABBまでの最短距離を計算（2m以内）
  const dx = Math.max(
    blockLoc.x - playerLoc.x,
    0,
    playerLoc.x - (blockLoc.x + 1),
  );
  const dy = Math.max(
    blockLoc.y - playerLoc.y,
    0,
    playerLoc.y - (blockLoc.y + 1),
  );
  const dz = Math.max(
    blockLoc.z - playerLoc.z,
    0,
    playerLoc.z - (blockLoc.z + 1),
  );
  const distance = Math.hypot(dx, dy, dz);

  return distance <= 2.0;
}

/**
 * プレイヤーのスライディング処理を開始します。
 * @param player 対象プレイヤー
 * @param allowInAir 空中での発動を許可するかどうか（足元ブロック殴り時など）
 */
function tryStartSliding(player: Player, allowInAir = false): void {
  // 既にスライディングまたはスライディングジャンプ中の場合は多重発動しない
  if (activeSlides.has(player.id)) {
    return;
  }

  // 接地判定チェック（allowInAir が false の場合のみ地上必須）
  if (REQUIRE_ON_GROUND && !allowInAir && !player.isOnGround) {
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
  // 1. 毎Tickごとの移動更新ループを最優先で登録（他のリスナーでエラーが起きても確実に動作させる）
  system.runInterval(() => {
    if (activeSlides.size === 0) return;

    for (const player of world.getAllPlayers()) {
      const slideState = activeSlides.get(player.id);
      if (!slideState) continue;

      if (!player.isValid) {
        activeSlides.delete(player.id);
        continue;
      }

      // フェーズごとの持続時間・終了判定
      if (slideState.phase === "sliding") {
        // 通常スライディング: 空中にいる間はタイマーをリセットして持続時間を延長
        if (!player.isOnGround) {
          slideState.remainingTicks = SLIDE_DURATION_TICKS;
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

      // スライディング中に空中にいる場合、斜面に沿わせるため下方向の追加インパルスを付与
      if (slideState.phase === "sliding" && !player.isOnGround) {
        impulse.y -= SLIDE_DOWNWARD_IMPULSE;
      }

      player.applyImpulse(impulse);
    }
  }, 1);

  // 2. ボタン入力イベント（シフトで開始、ジャンプでスライディングジャンプへ移行）
  try {
    world.afterEvents.playerButtonInput.subscribe((event) => {
      // シフト（スニーク）入力があったタイミングでスライディング開始
      if (
        event.button === InputButton.Sneak &&
        event.newButtonState === ButtonState.Pressed
      ) {
        tryStartSliding(event.player);
        return;
      }

      // スライディング中にジャンプ入力があった場合、スライディングを解除してスライディングジャンプを発動
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

  // 3. アイテム使用時（雪玉または釣竿）にスライディングを発動
  try {
    world.beforeEvents.itemUse.subscribe((event) => {
      const itemTypeId = event.itemStack.typeId;
      if (
        itemTypeId === "minecraft:snowball" ||
        itemTypeId === "minecraft:fishing_rod"
      ) {
        event.cancel = true; // 消費・キャストをキャンセル
        system.run(() => {
          tryStartSliding(event.source);
        });
      }
    });
  } catch (e) {
    console.warn("itemUse subscription failed:", e);
  }

  // 4. メインハンド素手でブロックを殴ったとき（entityHitBlock）
  try {
    world.afterEvents.entityHitBlock.subscribe((event) => {
      // 攻撃元がプレイヤーであることを確認
      if (!(event.damagingEntity instanceof Player)) {
        return;
      }
      const player = event.damagingEntity;

      // メインハンドが素手（何も持っていない）であることを確認
      if (!isMainHandEmpty(player)) {
        return;
      }

      // 殴ったブロックが「足元から2m以内かつy座標が足元〜その一マス下」の場合
      if (isValidBreakTarget(player, event.hitBlock.location)) {
        // 空中でも発動可能（allowInAir = true）
        tryStartSliding(player, true);
      }
    });
  } catch (e) {
    console.warn("entityHitBlock subscription failed:", e);
  }

  // 5. プレイヤー切断時のクリーンアップ
  world.afterEvents.playerLeave.subscribe((event) => {
    activeSlides.delete(event.playerId);
  });
}
