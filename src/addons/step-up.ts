import {
  world,
  system,
  Player,
  Block,
  type BlockRaycastOptions,
  type Vector3,
} from "@minecraft/server";
import { hasBlockCollisionFromAirFaces } from "../utils/collision.utils";
import { calculateDistanceToHitFace } from "./auto-jump";
import { calculateImpulseForNTicks } from "../utils/impulse.utils";

// ==========================================
// 定数・パラメータ設定
// ==========================================

/**
 * 段差を登るのにかけるTick数（1以上の整数。1なら即時1tick、3なら3tickかけてスムーズに登る）
 */
export const STEP_UP_DURATION_TICK = 2;

export const IMPULSE_Y = calculateImpulseForNTicks(STEP_UP_DURATION_TICK);

/**
 * 1tick目に付与する垂直（上昇）インパルス
 */
export const STEP_UP_LIFT_IMPULSE_Y = IMPULSE_Y;

/**
 * 目標高度到達時（STEP_UP_DURATION_TICK後）に付与する垂直（打ち消し）インパルス
 */
export const STEP_UP_CANCEL_IMPULSE_Y = -IMPULSE_Y;

/**
 * 登り切った際に付与する水平（XZ方向）固定インパルス強度（ベクトルの長さ）
 */
export const STEP_UP_IMPULSE_XZ = 0.1;

/**
 * プレイヤーのAABB半幅（Minecraftデフォルト: 0.3ブロック）
 */
export const STEP_UP_AABB_HALF_WIDTH = 0.3;

/**
 * ブロックへの接近検知マージン（ブロック数）
 */
export const STEP_UP_PROXIMITY_MARGIN = 0.1;

/**
 * 東西南北（直交4方向）の発動許容距離
 * プレイヤー中心からAABB外側0.1mまで = 0.3m + 0.1m = 0.40m
 */
export const STEP_UP_CARDINAL_DISTANCE = 0.4;

/**
 * 角（対角4方向）の発動許容距離
 * プレイヤー中心からAABB角の外側0.1mまで = 0.3√2 + 0.1m ≈ 0.5243m
 */
export const STEP_UP_DIAGONAL_DISTANCE =
  STEP_UP_AABB_HALF_WIDTH * Math.SQRT2 + STEP_UP_PROXIMITY_MARGIN;

/**
 * レイキャスト照射の足元からのYオフセット（ブロック数）
 * プレイヤーは0.6mの段差を通常歩行で登れるため、1マス（1.0m）の段差を検知すべく0.61mに設定
 */
export const STEP_UP_RAY_Y_OFFSET = 0.61;

/**
 * レイキャスト照射時の最大探索距離（マージンを持たせて余裕を持って探索）
 * 0.4m等の境界付近での浮動小数点誤差による取りこぼしを防ぐため1.2mまで探索し、
 * 距離判定は実測値で厳密に行う
 */
export const STEP_UP_RAY_SEARCH_DISTANCE = 1.2;

/**
 * ステップアップ発動後の再発動クールダウン（tick）
 */
export const STEP_UP_COOLDOWN_TICKS = 1;

/**
 * 移動方向（速度）との内積チェックを行うかどうか
 * false にすると、壁に密着して静止している状態でも段差を登れるようになります
 */
export const STEP_UP_CHECK_MOVEMENT_DIRECTION = false;

/**
 * デバッグ設定
 */
export const STEP_UP_DEBUG = {
  /** デバッグモード全体の有効/無効 */
  enabled: true,
  /** アクションバーに毎tickの判定状況・拒否理由をリアルタイム表示 */
  actionBar: true,
  /** ステップアップ発動時にチャットへ詳細ログを送信 */
  chatOnTrigger: true,
  /** 拒否・不発理由をチャットに送信（頻度を抑えて変化時のみ送信） */
  chatOnRejectChange: true,
  /** レイキャストの照射方向とヒット地点にパーティクルを表示 */
  particles: true,
};

// ==========================================
// 方向定義
// ==========================================

const INV_SQRT2 = 1 / Math.SQRT2;

export interface StepUpRayDirection {
  /** 方向の識別名 */
  name: string;
  /** 短縮表示名 */
  shortName: string;
  /** 水平方向単位ベクトル (X, Y=0, Z) */
  direction: Vector3;
  /** 発動許容最大距離 */
  maxAllowedDistance: number;
  /** 斜め（角）方向かどうか */
  isDiagonal: boolean;
}

/**
 * プレイヤーの回転に依存しない固定の8方向レイキャスト定義（ワールド座標・AABB準拠）
 */
export const STEP_UP_RAY_DIRECTIONS: readonly StepUpRayDirection[] = [
  // 東西南北（直交4方向）
  {
    name: "East (+X)",
    shortName: "E",
    direction: { x: 1, y: 0, z: 0 },
    maxAllowedDistance: STEP_UP_CARDINAL_DISTANCE,
    isDiagonal: false,
  },
  {
    name: "West (-X)",
    shortName: "W",
    direction: { x: -1, y: 0, z: 0 },
    maxAllowedDistance: STEP_UP_CARDINAL_DISTANCE,
    isDiagonal: false,
  },
  {
    name: "South (+Z)",
    shortName: "S",
    direction: { x: 0, y: 0, z: 1 },
    maxAllowedDistance: STEP_UP_CARDINAL_DISTANCE,
    isDiagonal: false,
  },
  {
    name: "North (-Z)",
    shortName: "N",
    direction: { x: 0, y: 0, z: -1 },
    maxAllowedDistance: STEP_UP_CARDINAL_DISTANCE,
    isDiagonal: false,
  },
  // 角（対角4方向）
  {
    name: "North-East (+X, -Z)",
    shortName: "NE",
    direction: { x: INV_SQRT2, y: 0, z: -INV_SQRT2 },
    maxAllowedDistance: STEP_UP_DIAGONAL_DISTANCE,
    isDiagonal: true,
  },
  {
    name: "North-West (-X, -Z)",
    shortName: "NW",
    direction: { x: -INV_SQRT2, y: 0, z: -INV_SQRT2 },
    maxAllowedDistance: STEP_UP_DIAGONAL_DISTANCE,
    isDiagonal: true,
  },
  {
    name: "South-East (+X, +Z)",
    shortName: "SE",
    direction: { x: INV_SQRT2, y: 0, z: INV_SQRT2 },
    maxAllowedDistance: STEP_UP_DIAGONAL_DISTANCE,
    isDiagonal: true,
  },
  {
    name: "South-West (-X, +Z)",
    shortName: "SW",
    direction: { x: -INV_SQRT2, y: 0, z: INV_SQRT2 },
    maxAllowedDistance: STEP_UP_DIAGONAL_DISTANCE,
    isDiagonal: true,
  },
] as const;

// ==========================================
// 状態管理
// ==========================================

interface StepUpState {
  /** 次に判定可能になるtick */
  canTriggerAfterTick: number;
  /** 現在ステップアップ処理実行中か */
  isExecuting: boolean;
  /** 直前に通知した拒否理由（チャット連投防止用） */
  lastRejectReason?: string;
  /** 直前に拒否理由をチャット通知したtick */
  lastRejectChatTick?: number;
}

const stepUpStates = new Map<string, StepUpState>();

function getOrCreateState(playerId: string): StepUpState {
  let state = stepUpStates.get(playerId);
  if (!state) {
    state = {
      canTriggerAfterTick: 0,
      isExecuting: false,
    };
    stepUpStates.set(playerId, state);
  }
  return state;
}

// ==========================================
// ブロック判定ユーティリティ
// ==========================================

/**
 * ステップアップの対象外ブロック（階段・フェンス等）であるか判定します。
 */
export function isIgnoredBlock(block: Block): boolean {
  const typeId = block.typeId;

  // 階段（"~~~_stairs"）: バニラで歩行登坂可能なため無視
  if (typeId.endsWith("_stairs")) {
    return true;
  }

  // フェンス（"_fence"）: 衝突高さが1.5mあるため無視
  if (typeId.endsWith("_fence") || typeId.includes("_fence")) {
    return true;
  }

  return false;
}

/**
 * 対象ブロックの頭上にプレイヤーが登れる空間（クリアランス）があるか判定します。
 * ブロックの上1マスおよび上2マスの空間に当たり判定がないことを確認します。
 */
export function hasClearanceAbove(block: Block): boolean {
  const above1 = block.above(1);
  const above2 = block.above(2);

  const hasCollision1 = hasBlockCollisionFromAirFaces(above1);
  const hasCollision2 = hasBlockCollisionFromAirFaces(above2);

  return !hasCollision1 && !hasCollision2;
}

// ==========================================
// デバッグ用データ型
// ==========================================

export interface RaycastDebugInfo {
  rayDef: StepUpRayDirection;
  hit: boolean;
  block?: Block;
  dist: number;
  inRange: boolean;
  ignored: boolean;
  hasClearance: boolean;
  dotOk: boolean;
  rejectReason?: string;
}

export interface DetectionResult {
  hitBlock: Block;
  rayDef: StepUpRayDirection;
  distance: number;
}

export interface StepUpDebugReport {
  isOnGround: boolean;
  vel: Vector3;
  speed: number;
  isExecuting: boolean;
  cdRemaining: number;
  rays: RaycastDebugInfo[];
  nearestRay?: RaycastDebugInfo;
  chosenTarget?: DetectionResult;
  failureReason?: string;
}

// ==========================================
// ステップアップ判定 & 実行
// ==========================================

/**
 * プレイヤーの周囲8方向にレイキャストを飛ばし、ステップアップ対象となるブロックを検知します。
 * 同時にデバッグレポートを生成します。
 */
function evaluateStepUpTarget(
  player: Player,
  state: StepUpState,
  currentTick: number,
): StepUpDebugReport {
  const loc = player.location;
  const vel = player.getVelocity();
  const horizSpeed = Math.hypot(vel.x, vel.z);
  const cdRemaining = Math.max(0, state.canTriggerAfterTick - currentTick);

  const report: StepUpDebugReport = {
    isOnGround: player.isOnGround,
    vel,
    speed: horizSpeed,
    isExecuting: state.isExecuting,
    cdRemaining,
    rays: [],
  };

  // 基本チェック
  if (!player.isOnGround) {
    report.failureReason = "空中(!isOnGround)";
    return report;
  }

  if (vel.y > 0.05) {
    report.failureReason = `上昇中(vy=${vel.y.toFixed(2)})`;
    return report;
  }

  if (state.isExecuting) {
    report.failureReason = "実行中(isExecuting)";
    return report;
  }

  if (cdRemaining > 0) {
    report.failureReason = `クールダウン中(${cdRemaining}t)`;
    return report;
  }

  const startPos: Vector3 = {
    x: loc.x,
    y: loc.y + STEP_UP_RAY_Y_OFFSET,
    z: loc.z,
  };

  const dimension = player.dimension;
  let bestResult: DetectionResult | undefined = undefined;
  let nearestRay: RaycastDebugInfo | undefined = undefined;

  const options: BlockRaycastOptions = {
    maxDistance: STEP_UP_RAY_SEARCH_DISTANCE,
    includePassableBlocks: false, // 草・花・松明などは除外
    includeLiquidBlocks: false, // 水・溶岩は除外
  };

  for (const rayDef of STEP_UP_RAY_DIRECTIONS) {
    const hit = dimension.getBlockFromRay(startPos, rayDef.direction, options);

    const rayInfo: RaycastDebugInfo = {
      rayDef,
      hit: !!hit,
      dist: Infinity,
      inRange: false,
      ignored: false,
      hasClearance: true,
      dotOk: true,
    };

    if (hit) {
      rayInfo.block = hit.block;

      // 衝突面までの厳密な幾何距離を算出
      const dist = calculateDistanceToHitFace(
        startPos,
        rayDef.direction,
        hit.block.location,
        hit.face,
      );
      rayInfo.dist = dist;

      // 最も近いレイを記録（レポート用）
      if (!nearestRay || dist < nearestRay.dist) {
        nearestRay = rayInfo;
      }

      // 距離判定（0.40m / 0.5243m 以内か）
      // ※ 微小な誤差を考慮して 0.01m のバッファを許容
      const inRange = dist <= rayDef.maxAllowedDistance + 0.01;
      rayInfo.inRange = inRange;

      if (!inRange) {
        rayInfo.rejectReason = `範囲外(${dist.toFixed(2)}m > ${rayDef.maxAllowedDistance.toFixed(2)}m)`;
      } else {
        // 階段やフェンスの除外
        const ignored = isIgnoredBlock(hit.block);
        rayInfo.ignored = ignored;
        if (ignored) {
          rayInfo.rejectReason = `除外ブロック(${hit.block.typeId.replace("minecraft:", "")})`;
        } else {
          // 頭上クリアランスチェック
          const clearance = hasClearanceAbove(hit.block);
          rayInfo.hasClearance = clearance;
          if (!clearance) {
            rayInfo.rejectReason = "頭上クリアランス不足";
          } else {
            // 移動方向チェック（設定が有効な場合のみ）
            if (STEP_UP_CHECK_MOVEMENT_DIRECTION && horizSpeed > 0.02) {
              const dot =
                vel.x * rayDef.direction.x + vel.z * rayDef.direction.z;
              if (dot < -0.01) {
                rayInfo.dotOk = false;
                rayInfo.rejectReason = `逆方向移動(dot=${dot.toFixed(2)})`;
              }
            }

            // すべてクリアした場合、採用候補
            if (rayInfo.dotOk) {
              if (
                !bestResult ||
                dist < bestResult.distance - 0.02 ||
                (Math.abs(dist - bestResult.distance) <= 0.02 &&
                  !rayDef.isDiagonal &&
                  bestResult.rayDef.isDiagonal)
              ) {
                bestResult = {
                  hitBlock: hit.block,
                  rayDef,
                  distance: dist,
                };
              }
            }
          }
        }
      }
    } else {
      rayInfo.rejectReason = "ブロック未衝突";
    }

    report.rays.push(rayInfo);
  }

  report.nearestRay = nearestRay;
  report.chosenTarget = bestResult;

  if (!bestResult) {
    if (nearestRay && nearestRay.hit) {
      report.failureReason = `${nearestRay.rayDef.shortName}: ${nearestRay.rejectReason}`;
    } else {
      report.failureReason = "周囲にブロックなし";
    }
  }

  return report;
}

/**
 * デバッグパーティクルを生成してレイの照射状況を視覚化します。
 */
function renderDebugParticles(player: Player, report: StepUpDebugReport): void {
  if (!STEP_UP_DEBUG.particles) return;

  const loc = player.location;
  const dimension = player.dimension;
  const rayY = loc.y + STEP_UP_RAY_Y_OFFSET;

  try {
    // プレイヤー中心（レイ始点）に小さなパーティクル
    dimension.spawnParticle("minecraft:villager_happy", {
      x: loc.x,
      y: rayY,
      z: loc.z,
    });

    for (const ray of report.rays) {
      const dir = ray.rayDef.direction;
      // 許容距離地点
      const checkDist = ray.rayDef.maxAllowedDistance;
      const targetPos: Vector3 = {
        x: loc.x + dir.x * checkDist,
        y: rayY,
        z: loc.z + dir.z * checkDist,
      };

      if (report.chosenTarget && report.chosenTarget.rayDef === ray.rayDef) {
        // 発動対象となったレイ: 緑のハッピーパーティクル
        dimension.spawnParticle("minecraft:villager_happy", targetPos);
      } else if (ray.hit && ray.inRange) {
        // 範囲内だが除外されたブロック: 赤石ダストや炎
        dimension.spawnParticle("minecraft:basic_flame_particle", targetPos);
      }
    }
  } catch {
    // パーティクル生成エラーは無視
  }
}

/**
 * ステップアップの2段階インパルスを実行します。
 *
 * 1. 発動時: Y方向に計算された垂直上昇インパルス（STEP_UP_LIFT_IMPULSE_Y）を付与
 * 2. STEP_UP_DURATION_TICK後: Y方向に打ち消しインパルス（STEP_UP_CANCEL_IMPULSE_Y）を与えつつ、
 *    XZ方向に登りたいブロック方向の固定値インパルスを付与して段差の上へ着地
 */
function executeStepUp(
  player: Player,
  state: StepUpState,
  target: DetectionResult,
  currentTick: number,
): void {
  state.isExecuting = true;
  // 上昇中および上昇後のクールダウン（登り切るまでのTick数 + クールダウンTick数）
  state.canTriggerAfterTick =
    currentTick + STEP_UP_DURATION_TICK + STEP_UP_COOLDOWN_TICKS;

  const { direction, name } = target.rayDef;

  // 1tick目: Y方向に垂直上昇インパルスを適用
  player.applyImpulse({
    x: 0,
    y: STEP_UP_LIFT_IMPULSE_Y,
    z: 0,
  });

  if (STEP_UP_DEBUG.enabled && STEP_UP_DEBUG.chatOnTrigger) {
    const blockName = target.hitBlock.typeId.replace("minecraft:", "");
    player.sendMessage(
      `§b[StepUp] §a★発動! §f方向: §e${name} §7(所要: §e${STEP_UP_DURATION_TICK}t§7, 距離: §a${target.distance.toFixed(2)}m§7) §7ブロック: §b${blockName}`,
    );
  }

  // STEP_UP_DURATION_TICK 後: 目標高度に達したタイミングで垂直上昇を打ち消し、XZ方向に固定長インパルスを適用
  // directionは単位ベクトルのため、STEP_UP_IMPULSE_XZを掛けることで
  // 直交方向は片方が0、斜め方向は両方にインパルスが入り、ベクトルの長さは常に一定に保たれます。
  const impulseX = direction.x * STEP_UP_IMPULSE_XZ;
  const impulseZ = direction.z * STEP_UP_IMPULSE_XZ;

  system.runTimeout(() => {
    state.isExecuting = false;

    if (!player.isValid) {
      return;
    }

    player.applyImpulse({
      x: impulseX,
      y: STEP_UP_CANCEL_IMPULSE_Y,
      z: impulseZ,
    });
  }, STEP_UP_DURATION_TICK);
}

/**
 * 毎tick呼び出され、ステップアップ条件を満たしているか判定して発動します。
 * 判定結果をリアルタイムでデバッグ表示します。
 */
export function checkAndTriggerStepUp(player: Player): void {
  if (!player.isValid) return;

  const currentTick = system.currentTick;
  const state = getOrCreateState(player.id);

  // 評価とレポート生成
  const report = evaluateStepUpTarget(player, state, currentTick);

  // パーティクル視覚化
  if (STEP_UP_DEBUG.enabled) {
    renderDebugParticles(player, report);
  }

  // アクションバーリアルタイムデバッグ表示
  if (STEP_UP_DEBUG.enabled && STEP_UP_DEBUG.actionBar) {
    const gStr = report.isOnGround ? "§aG:○§r" : "§cG:×§r";
    const vyStr = `vy:${report.vel.y >= 0 ? "+" : ""}${report.vel.y.toFixed(2)}`;
    const spdStr = `spd:${report.speed.toFixed(2)}`;
    const cdStr =
      report.cdRemaining > 0 ? `§eCD:${report.cdRemaining}§r` : "§7CD:0§r";

    let statusStr = "";
    if (report.chosenTarget) {
      const t = report.chosenTarget;
      const bName = t.hitBlock.typeId.replace("minecraft:", "");
      statusStr = `§a★発動可能 [${t.rayDef.shortName} ${t.distance.toFixed(2)}m ${bName}]§r`;
    } else {
      statusStr = `§c[NG: ${report.failureReason ?? "不明"}]§r`;
    }

    player.onScreenDisplay.setActionBar(
      `§bStepUp§r ${gStr} ${vyStr} ${spdStr} ${cdStr} | ${statusStr}`,
    );
  }

  // 拒否理由が変化した時のチャット通知（原因究明用）
  if (
    STEP_UP_DEBUG.enabled &&
    STEP_UP_DEBUG.chatOnRejectChange &&
    report.failureReason &&
    report.failureReason !== state.lastRejectReason
  ) {
    // 短時間の連投防止（20tick = 1秒に1回まで）
    if (
      !state.lastRejectChatTick ||
      currentTick - state.lastRejectChatTick >= 20
    ) {
      if (report.nearestRay && report.nearestRay.hit) {
        const b = report.nearestRay.block;
        const bName = b ? b.typeId.replace("minecraft:", "") : "unknown";
        player.sendMessage(
          `§7[StepUp:Debug] 判定: §e${report.failureReason} §7| 最寄: §b${report.nearestRay.rayDef.shortName} (${report.nearestRay.dist.toFixed(2)}m) [${bName}]`,
        );
        state.lastRejectReason = report.failureReason;
        state.lastRejectChatTick = currentTick;
      }
    }
  }

  // 発動可能な場合は実行
  if (report.chosenTarget) {
    executeStepUp(player, state, report.chosenTarget, currentTick);
  }
}

// ==========================================
// メインエントリーポイント
// ==========================================

export function stepUpMain(): void {
  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      checkAndTriggerStepUp(player);
    }
  }, 1);
}
