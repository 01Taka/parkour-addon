import { Player, system, world } from "@minecraft/server";
import { getPlayerAABB } from "../utils/positional.utils";
import { getNearestFaceSegment } from "../utils/direction.utils";
import { calculateDistanceToHitFace } from "../utils/collision.utils";
import {
  type LiftImpulseResult,
  calculateLiftImpulseAccurate,
} from "../utils/impulse.utils";
import { PlayerStateManager } from "../classes/player-state-manager.class";
import { getMovementInputAngle } from "../utils/input.utils";
import { PlayerDirectionResolver } from "../classes/player-direction-resolver.class";

/**
 * 浮き上がる目標高さ（ブロック数）
 */
export const AUTO_JUMP_TARGET_HEIGHT = 1.05;

/**
 * ダッシュ（スプリント）中のXZ方向ボーナス加速量
 */
export const AUTO_JUMP_SPRINT_BONUS = 0.2;

export const AUTO_JUMP_FORWARD_SIN_THRESHOLD = Math.sin((30 * Math.PI) / 180);

/**
 * calculateLiftImpulseAccurate ははじめに一回だけ呼び出して、変数に値を保存します。
 */
export const PRECALCULATED_LIFT: LiftImpulseResult =
  calculateLiftImpulseAccurate(AUTO_JUMP_TARGET_HEIGHT);

/**
 * ジャンプ発動からブレーキインパルスを付与するまでの遅延Tick数
 * デフォルト: PRECALCULATED_LIFT.ticksToApex + 1（最高高度到達の次tick）
 * 任意の整数Tick（例: 5, 6 など）を直接指定することも可能です。
 */
export const AUTO_JUMP_BRAKE_DELAY_TICKS: number =
  PRECALCULATED_LIFT.ticksToApex + 1;

function applyJumpImpulse(player: Player) {
  const dir = PlayerDirectionResolver.get(player).worldInput.normalizedXZ;

  player.applyImpulse({
    x: dir.x * 0.2,
    y: PRECALCULATED_LIFT.impulse.y,
    z: dir.z * 0.2,
  });
}

function getReachBlockTick(player: Player) {
  const aabb = getPlayerAABB(player);
  const { movement, worldInput } = PlayerDirectionResolver.get(player);

  const dir = worldInput.vector;
  if (worldInput.xzHypot === 0)
    return {
      minTick: Infinity,
      durations: [Infinity, Infinity],
    };

  const segments = getNearestFaceSegment(aabb, dir, 0.01);
  if (segments.length === 0)
    return {
      minTick: Infinity,
      durations: [Infinity, Infinity],
    };

  const durations = segments.map((segment) => {
    const distance = calculateDistanceToHitFace(
      player.dimension,
      {
        x: segment.x,
        y: player.location.y + 0.61,
        z: segment.z,
      },
      dir,
      {
        maxDistance: 5,
        includeLiquidBlocks: false,
        includePassableBlocks: false,
      },
    );

    const speed = movement.xzHypot;
    if (distance !== null && speed !== 0) {
      return distance / speed;
    }
    return Infinity;
  });

  player.sendMessage(
    `${durations[0]?.toFixed(2) ?? "null"}, ${durations[1]?.toFixed(2) ?? "null"}`,
  );
  return {
    minTick: Math.min(...durations),
    durations,
  };
}

export function simpleAutoJumpMain() {
  system.runInterval(() => {
    for (let player of world.getAllPlayers()) {
      const canAutoJump = PlayerStateManager.get(
        player.id,
        "autoJump_canAutoJump",
        true,
      );

      if (player.isOnGround) {
        if (!canAutoJump) {
          PlayerStateManager.set(player.id, "autoJump_canAutoJump", true);
          continue;
        }

        const angle = getMovementInputAngle(player);
        const { minTick: reachTick } = getReachBlockTick(player);

        if (
          reachTick !== Infinity &&
          angle !== null &&
          reachTick <= PRECALCULATED_LIFT.ticksToApex &&
          Math.abs(angle) < AUTO_JUMP_FORWARD_SIN_THRESHOLD
        ) {
          PlayerStateManager.set(player.id, "autoJump_canAutoJump", false);
          applyJumpImpulse(player);
        }
      }
    }
  }, 1);
}
