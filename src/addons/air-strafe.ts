import {
  world,
  system,
  InputButton,
  ButtonState,
  Player,
  EquipmentSlot,
} from "@minecraft/server";
import { isSliding } from "./sliding";
import { calculateVelocityImpulse } from "../utils/impulse.utils";

// ==========================================
// 定数定義・パラメータ設定
// ==========================================

/** ジャンプ後の初回入力受付時間 (Tick数) */
export const AIR_STRAFE_WINDOW_TICKS = 8;

/** ストレイフ発動時の持続時間 (Tick数) */
export const STRAFE_DURATION_TICKS = 10;

/** 1Tickあたりに曲げる旋回角度（度） */
export const STRAFE_TURN_ANGLE_DEG = 5.0;

/** 物理移動方向と現在の視線方向のズレのsin閾値（追従判定用） */
export const STRAFE_SIN_DIFF_THRESHOLD = 0.3;

/** ストレイフ成功時に毎Tick加算される速度ボーナス（ブロック/tick。0なら速度維持） */
export const STRAFE_SPEED_BONUS_PER_TICK = 0.01;

/** ジャンプ後、初速計測および発動までに待機する最小Tick数 */
export const STRAFE_START_DELAY_TICKS = 2;

/** スティック/キー入力が「横方向」と判定される閾値（遊び） */
export const STRAFE_INPUT_THRESHOLD = 0.2;

/** キーが離されている（ニュートラル）と判定する MovementVector.x の閾値 */
export const INPUT_NEUTRAL_THRESHOLD = 0.2;

/**
 * プレイヤーがメインハンドに羽（検証用無効化アイテム）を持っているか判定します。
 */
export function isHoldingFeather(player: Player): boolean {
  try {
    const equippable = player.getComponent("minecraft:equippable");
    const mainHandItem = equippable
      ? equippable.getEquipment(EquipmentSlot.Mainhand)
      : player
          .getComponent("minecraft:inventory")
          ?.container?.getItem(player.selectedSlotIndex);

    return mainHandItem?.typeId === "minecraft:feather";
  } catch {
    return false;
  }
}

// ==========================================
// 状態管理
// ==========================================

type StrafePhase = "waiting_input" | "active";

interface AirStrafeState {
  /** 現在のフェーズ */
  phase: StrafePhase;
  /** 残りTick数 */
  remainingTicks: number;
  /** ストレイフ開始時点の元の水平速度の大きさ */
  originalSpeed: number;
  /** すでに空中に離陸したか */
  hasLeftGround: boolean;
  /** 曲がる方向（true: 左 / 反時計回り、false: 右 / 時計回り） */
  isLeft?: boolean;
  /** ジャンプ後の初速計測待機Tick数 */
  delayTicks: number;
}

const activeAirStrafes = new Map<string, AirStrafeState>();

// ==========================================
// 幾何・物理計算ヘルパー
// ==========================================

/**
 * 2D単位ベクトルを指定角度だけ回転させた新しい単位ベクトルを計算します。
 * マイクラ座標系（+X: 東, +Z: 南）において、上空から見下ろした平面回転：
 * - Aキー: 左曲がり
 * - Dキー: 右曲がり
 */
function rotateVector2D(
  dirX: number,
  dirZ: number,
  angleDeg: number,
  isLeft: boolean,
): { x: number; z: number } {
  const angleRad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  if (isLeft) {
    // 左曲がり
    return {
      x: dirX * cosA - dirZ * sinA,
      z: dirX * sinA + dirZ * cosA,
    };
  } else {
    // 右曲がり
    return {
      x: dirX * cosA + dirZ * sinA,
      z: -dirX * sinA + dirZ * cosA,
    };
  }
}

/**
 * プレイヤーの現在の視線正面の水平単位ベクトルを取得します。
 */
function getViewForward(player: Player): { x: number; z: number } | null {
  const view = player.getViewDirection();
  const horizontalLength = Math.hypot(view.x, view.z);
  if (horizontalLength < 0.0001) {
    return null;
  }
  return {
    x: view.x / horizontalLength,
    z: view.z / horizontalLength,
  };
}

// ==========================================
// メインロジック
// ==========================================

/**
 * エアストレイフ機能のメインループおよびイベント購読を初期化します。
 */
export function airStrafeMain(): void {
  // 1. 毎Tickごとの監視・インパルス付与ループ
  system.runInterval(() => {
    if (activeAirStrafes.size === 0) return;

    for (const player of world.getAllPlayers()) {
      const state = activeAirStrafes.get(player.id);
      if (!state) continue;

      if (!player.isValid) {
        activeAirStrafes.delete(player.id);
        continue;
      }

      // スライディングが開始された場合はキャンセル
      if (isSliding(player.id)) {
        activeAirStrafes.delete(player.id);
        continue;
      }

      // 羽を持っている場合はキャンセル（検証用）
      if (isHoldingFeather(player)) {
        activeAirStrafes.delete(player.id);
        continue;
      }

      // 着地判定（一度離陸した後に着地した時点で終了）
      if (!player.isOnGround) {
        state.hasLeftGround = true;
      } else if (state.hasLeftGround) {
        activeAirStrafes.delete(player.id);
        continue;
      }

      const currentVelocity = player.getVelocity();
      const currentSpeed = Math.hypot(currentVelocity.x, currentVelocity.z);

      let currentInputX = 0;
      try {
        const moveVector = player.inputInfo.getMovementVector();
        currentInputX = moveVector.x;
      } catch {
        // ignore
      }

      // --- フェーズ 1: 初回入力待ち（ディレイ消化待ち含む） ---
      if (state.phase === "waiting_input") {
        if (state.delayTicks > 0) {
          state.delayTicks -= 1;
        } else {
          const isLeft = currentInputX <= -STRAFE_INPUT_THRESHOLD;
          const isRight = currentInputX >= STRAFE_INPUT_THRESHOLD;

          if (isLeft || isRight) {
            state.phase = "active";
            state.remainingTicks = STRAFE_DURATION_TICKS;
            state.originalSpeed = currentSpeed;
            state.isLeft = isLeft;
          }
        }

        state.remainingTicks -= 1;
        if (state.remainingTicks <= 0) {
          activeAirStrafes.delete(player.id);
          continue;
        }
      }

      // --- フェーズ 2: 持続旋回・インパルス付与 ---
      if (state.phase === "active") {
        let targetX = currentVelocity.x;
        let targetZ = currentVelocity.z;
        let appliedTurn = false;

        const isLeft = state.isLeft ?? false;
        // まだ開始時と同じ方向に入力が維持されているか判定
        const hasInput = isLeft
          ? currentInputX <= -STRAFE_INPUT_THRESHOLD
          : currentInputX >= STRAFE_INPUT_THRESHOLD;

        const viewForward = getViewForward(player);

        if (hasInput && viewForward && currentSpeed > 0.001) {
          // 現在の物理移動方向単位ベクトル
          const dirX = currentVelocity.x / currentSpeed;
          const dirZ = currentVelocity.z / currentSpeed;

          // 物理移動方向と現在の視線方向の2D外積の絶対値（sin値 = ズレの大きさ）
          const sinDiff = Math.abs(dirX * viewForward.z - dirZ * viewForward.x);
          // 前進成分（cos値。真後ろを向いている場合は除外）
          const cosForward = dirX * viewForward.x + dirZ * viewForward.z;

          if (cosForward > 0 && sinDiff <= STRAFE_SIN_DIFF_THRESHOLD) {
            // 成功ボーナスを加算して速度を少し上昇
            state.originalSpeed += STRAFE_SPEED_BONUS_PER_TICK;

            // 現在の物理移動方向から定数角度曲げた目標方向ベクトルを計算
            const turnedDir = rotateVector2D(
              dirX,
              dirZ,
              STRAFE_TURN_ANGLE_DEG,
              isLeft,
            );

            // 目標速度
            targetX = turnedDir.x * state.originalSpeed;
            targetZ = turnedDir.z * state.originalSpeed;
            appliedTurn = true;
          }
        }

        // インパルスを受け取らなかった場合も、現在の進行方向のまま元の速度を維持
        if (!appliedTurn && currentSpeed > 0.001) {
          targetX = (currentVelocity.x / currentSpeed) * state.originalSpeed;
          targetZ = (currentVelocity.z / currentSpeed) * state.originalSpeed;
        }

        // calculateVelocityImpulse を使い、加速し続けないよう速度を一定に保つインパルスを計算
        const impulse = calculateVelocityImpulse({
          target: {
            x: targetX,
            y: null, // 垂直方向の落下軌道は維持
            z: targetZ,
          },
          current: currentVelocity,
          dragXZ: "air",
          gravity: false,
        });

        player.applyImpulse(impulse);

        state.remainingTicks -= 1;
        if (state.remainingTicks <= 0) {
          activeAirStrafes.delete(player.id);
        }
      }
    }
  }, 1);

  // 2. ジャンプ入力イベントの購読（スプリントジャンプ時に受付開始）
  try {
    world.afterEvents.playerButtonInput.subscribe((event) => {
      const player = event.player;
      if (!player.isValid) return;

      if (event.button === InputButton.Jump) {
        if (event.newButtonState !== ButtonState.Pressed) {
          return;
        }

        const currentVelocity = player.getVelocity();

        // 発動条件チェック
        if (
          !player.isSprinting ||
          currentVelocity.y <= 0 ||
          isSliding(player.id) ||
          isHoldingFeather(player)
        ) {
          return;
        }

        // ジャンプ時はストレイフの予約を行い、指定Tick待機後に初速を計測して発動
        activeAirStrafes.set(player.id, {
          phase: "waiting_input",
          remainingTicks: AIR_STRAFE_WINDOW_TICKS,
          originalSpeed: 0,
          hasLeftGround: true,
          delayTicks: STRAFE_START_DELAY_TICKS,
        });
      }
    });
  } catch (e) {
    console.warn("playerButtonInput subscription failed for airStrafe:", e);
  }

  // 3. プレイヤー退出時のクリーンアップ
  world.afterEvents.playerLeave.subscribe((event) => {
    activeAirStrafes.delete(event.playerId);
  });
}
