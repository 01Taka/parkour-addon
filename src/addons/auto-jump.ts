import { Player, system, world } from "@minecraft/server";
import { getNearestFaceSegment } from "../utils/geometry.utils";
import { getPlayerAABB, getMovementInputAngle } from "../utils/player.utils";
import { calculateDistanceToHitFace } from "../utils/collision.utils";
import {
  type LiftImpulseResult,
  calculateLiftImpulseAccurate,
  calculateVelocityImpulse,
} from "../utils/physics.utils";
import { PlayerStateManager } from "../classes/player-state-manager.class";
import { PlayerDirectionResolver } from "../classes/player-direction-resolver.class";
import { ADDON_KEYS } from "../classes/settings-ui-manager.class";
import { parkourEventHandler } from "../classes/parkour-event-handler.class";

/**
 * プレイヤー設定の型定義
 */
export type AutoJumpHeight = "fit" | "normal";
export type AutoJumpAngle = "narrow" | "wide" | "all";
export type AutoJumpMovement = "sprint" | "walk" | "any";

/**
 * オートジャンプの設定・定数
 */
export const AUTO_JUMP = {
  // PlayerStateManager 用キー
  keys: {
    canJump: "autoJump_canAutoJump",
    brakeTick: "autoJump_brakeTick",
    height: "autoJump_height",
    angle: "autoJump_angle",
    movement: "autoJump_movement",
  },

  // プレイヤー設定の初期値
  defaults: {
    height: "fit" as AutoJumpHeight,
    angle: "narrow" as AutoJumpAngle,
    movement: "sprint" as AutoJumpMovement,
  },

  // ジャンプ高さごとの事前計算値
  heights: {
    fit: (() => {
      const height = 1.05;
      const lift = calculateLiftImpulseAccurate(height);
      return { height, lift, brakeDelayTicks: lift.ticksToApex + 1 };
    })(),
    normal: (() => {
      const height = 1.25;
      const lift = calculateLiftImpulseAccurate(height);
      return { height, lift, brakeDelayTicks: lift.ticksToApex + 1 };
    })(),
  },

  // 発動角度の閾値（all は null でスキップ）
  angles: {
    narrow: Math.sin((30 * Math.PI) / 180),
    wide: Math.sin((120 * Math.PI) / 180),
    all: null,
  },

  forwardImpulse: 0.2,
  brakeFactor: 0.5,
  intervalTicks: 1,

  // 段差・障害物検出パラメータ
  detection: {
    stepHeight: 0.61,
    clearanceHeights: [1.01, 2.01],
    maxDistance: 5,
    segmentSpacing: 0.01,
    precisionDigits: 3,
    ledgeDepthThreshold: 2.1,
  },
} as const;

function applyJumpImpulse(player: Player, lift: LiftImpulseResult) {
  const dir = PlayerDirectionResolver.get(player).worldInput.normalizedXZ;

  player.applyImpulse({
    x: dir.x * AUTO_JUMP.forwardImpulse,
    y: lift.impulse.y,
    z: dir.z * AUTO_JUMP.forwardImpulse,
  });
}

function applyBrakeImpulse(player: Player) {
  const { xzHypot, vector } = PlayerDirectionResolver.get(player).movement;
  if (xzHypot === 0) return;

  const impulse = calculateVelocityImpulse({
    target: {
      x: vector.x * AUTO_JUMP.brakeFactor,
      y: null,
      z: vector.z * AUTO_JUMP.brakeFactor,
    },
    current: vector,
    dragXZ: player.isOnGround ? "ground" : "air",
  });

  player.applyImpulse(impulse);
}

function getDistanceToBlock(player: Player, shiftY: number) {
  const aabb = getPlayerAABB(player);
  const { worldInput } = PlayerDirectionResolver.get(player);

  const dir = worldInput.vector;
  if (worldInput.xzHypot === 0) return Infinity;

  const segments = getNearestFaceSegment(
    aabb,
    dir,
    AUTO_JUMP.detection.segmentSpacing,
  );
  if (segments.length === 0) return Infinity;

  const distances = segments.map((segment) => {
    const distance = calculateDistanceToHitFace(
      player.dimension,
      {
        x: segment.x,
        y: player.location.y + shiftY,
        z: segment.z,
      },
      dir,
      {
        maxDistance: AUTO_JUMP.detection.maxDistance,
        includeLiquidBlocks: false,
        includePassableBlocks: false,
      },
    );

    return distance ?? Infinity;
  });

  return Math.min(...distances);
}

function getOverBlockState(
  player: Player,
  shiftY: number,
  targetDistance: number,
) {
  const distance = getDistanceToBlock(player, shiftY);
  const precision = AUTO_JUMP.detection.precisionDigits;

  return {
    isFilled: targetDistance.toFixed(precision) >= distance.toFixed(precision),
    distance,
  };
}

/**
 * 発動する移動条件を満たしているかチェック
 */
function matchesMovementCondition(
  player: Player,
  condition: AutoJumpMovement,
): boolean {
  switch (condition) {
    case "sprint":
      return player.isSprinting && !player.isSneaking;
    case "walk":
      return !player.isSneaking;
    case "any":
      return true;
  }
}

/**
 * 発動する角度条件を満たしているかチェック
 */
function matchesAngleCondition(
  angle: number | null,
  condition: AutoJumpAngle,
): boolean {
  if (condition === "all") return true;
  if (angle === null) return false;

  const threshold = AUTO_JUMP.angles[condition];
  return Math.abs(angle) < threshold;
}

export function autoJumpMain() {
  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      if (!parkourEventHandler.isAddonAllowed(player, ADDON_KEYS.autoJump)) {
        continue;
      }

      const canAutoJump = PlayerStateManager.get(
        player.id,
        AUTO_JUMP.keys.canJump,
        true,
      );

      if (player.isOnGround) {
        if (!canAutoJump) {
          PlayerStateManager.set(player.id, AUTO_JUMP.keys.canJump, true);
          continue;
        }

        // --- プレイヤー設定の取得 ---
        const movementSetting = PlayerStateManager.get<AutoJumpMovement>(
          player.id,
          AUTO_JUMP.keys.movement,
          AUTO_JUMP.defaults.movement,
        );
        const angleSetting = PlayerStateManager.get<AutoJumpAngle>(
          player.id,
          AUTO_JUMP.keys.angle,
          AUTO_JUMP.defaults.angle,
        );
        const heightSetting = PlayerStateManager.get<AutoJumpHeight>(
          player.id,
          AUTO_JUMP.keys.height,
          AUTO_JUMP.defaults.height,
        );

        // 1. 移動条件チェック（不一致なら重いブロック判定をスキップ）
        if (!matchesMovementCondition(player, movementSetting)) {
          continue;
        }

        // 2. 角度条件チェック
        const angle = getMovementInputAngle(player);
        if (!matchesAngleCondition(angle, angleSetting)) {
          continue;
        }

        // 3. 段差までの距離と到達tickの判定
        const heightConfig = AUTO_JUMP.heights[heightSetting];
        const distance = getDistanceToBlock(
          player,
          AUTO_JUMP.detection.stepHeight,
        );
        const speed = PlayerDirectionResolver.get(player).movement.xzHypot;
        const reachTick = distance / speed;

        if (
          reachTick !== Infinity &&
          reachTick <= heightConfig.lift.ticksToApex
        ) {
          // 頭上クリアランスチェック
          const states = AUTO_JUMP.detection.clearanceHeights.map((shiftY) =>
            getOverBlockState(player, shiftY, distance),
          );
          if (states.some((state) => state.isFilled)) continue;

          // 段差上面の奥行き判定によるブレーキ予約
          if (
            states[0] &&
            states[0].distance - distance <=
              AUTO_JUMP.detection.ledgeDepthThreshold
          ) {
            PlayerStateManager.set(
              player.id,
              AUTO_JUMP.keys.brakeTick,
              system.currentTick + heightConfig.brakeDelayTicks,
            );
          }

          PlayerStateManager.set(player.id, AUTO_JUMP.keys.canJump, false);
          applyJumpImpulse(player, heightConfig.lift);
        }
      }

      if (
        PlayerStateManager.get(player.id, AUTO_JUMP.keys.brakeTick, Infinity) <=
        system.currentTick
      ) {
        PlayerStateManager.delete(player.id, AUTO_JUMP.keys.brakeTick);
        applyBrakeImpulse(player);
      }
    }
  }, AUTO_JUMP.intervalTicks);
}
