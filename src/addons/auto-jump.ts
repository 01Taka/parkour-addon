import {
  world,
  system,
  Player,
  Block,
  Direction,
  type BlockRaycastOptions,
  type Vector3,
} from "@minecraft/server";
import {
  calculateLiftImpulseAccurate,
  type LiftImpulseResult,
} from "../utils/impulse.utils";
import { hasBlockCollisionFromAirFaces } from "../utils/collision.utils";

// ==========================================
// 定数・パラメータ設定
// ==========================================

/**
 * 浮き上がる目標高さ（ブロック数）
 */
export const AUTO_JUMP_TARGET_HEIGHT = 1.05;

/**
 * ダッシュ（スプリント）中のXZ方向ボーナス加速量
 */
export const AUTO_JUMP_SPRINT_BONUS = 0.2;

/**
 * プレイヤーのAABB半幅（Minecraftデフォルト: 0.3ブロック）
 */
export const AUTO_JUMP_AABB_HALF_WIDTH = 0.3;

/**
 * レイキャスト照射の足元からのYオフセット（ブロック数）
 * プレイヤーは0.6mの高さまでジャンプなしで登れるため、
 * ジャンプなしで登れるブロック（ハーフブロック等）で誤発動しないよう0.61mに設定
 */
export const AUTO_JUMP_RAY_Y_OFFSET = 0.61;

/**
 * レイキャストの最大照射距離（ブロック数）
 */
export const AUTO_JUMP_MAX_RAY_DISTANCE = 4.0;

/**
 * 登った先（1ブロック上）の次の段差を探索する最大距離（ブロック数）
 */
export const AUTO_JUMP_UPPER_RAY_MAX_DISTANCE = 6.0;

/**
 * 次の段差が近接していると判定する距離閾値（ブロック数）
 */
export const AUTO_JUMP_BRAKE_NEXT_STEP_DISTANCE = 2.1;

/**
 * 次の段差が近接している場合に最高高度到達次tickで減速するインパルス比率
 */
export const AUTO_JUMP_BRAKE_RATIO = 0.33;

/**
 * オートジャンプ判定を行う最小水平速度（ブロック/tick）
 */
export const AUTO_JUMP_MIN_SPEED = 0.02;

/**
 * オートジャンプ発動後の再発動クールダウン（tick）(デフォルトなし)
 */
export const AUTO_JUMP_COOLDOWN_TICKS = 0;

/**
 * ブロック接着（密着）検知用レイキャストの照射距離（ブロック数）
 * 対角線半幅(約0.424m)および押し戻しマージンをカバーする0.45m
 */
export const AUTO_JUMP_FLUSH_RAY_DISTANCE = 0.45;

/**
 * 段差の上に空間があるか（登れる段差か）をチェックするかどうか
 */
export const AUTO_JUMP_CHECK_CLEARANCE = true;

/**
 * オートジャンプの発動方向モード
 * - "always": 移動方向を問わず発動
 * - "forward_only": 視線方向に対して前方（入力ズレ角のsinがsin60以下）に移動入力しているときのみ発動
 */
export type AutoJumpDirectionMode = "always" | "forward_only";

/**
 * オートジャンプの発動方向モード設定（デフォルト: "forward_only"）
 */
export const AUTO_JUMP_DIRECTION_MODE: AutoJumpDirectionMode = "forward_only";

/**
 * 前方移動判定のsin閾値（sin 60° ≈ 0.866025）
 * 視線方向に対する入力ズレ角のsinがこの値以下かつ前方入力（y > 0）がある場合に前方移動と判定
 */
export const AUTO_JUMP_FORWARD_SIN_THRESHOLD = Math.sin((60 * Math.PI) / 180);

/**
 * オートジャンプを発動させる状態（ステート）の設定インターフェース
 */
export interface AutoJumpTriggerStates {
  /** 密着状態（ブロックに接着・停止している状態）で発動するか */
  flush: boolean;
  /** 歩き状態（非ダッシュでの通常歩行移動中）で発動するか */
  walk: boolean;
  /** ダッシュ状態（ダッシュ／スプリント移動中）で発動するか */
  sprint: boolean;
}

/**
 * オートジャンプの発動状態設定
 * 密着状態, 歩き状態, ダッシュ状態 それぞれでオートジャンプが発動するかを選択できます。
 * デフォルトではダッシュのときだけ発動します。
 */
export const AUTO_JUMP_TRIGGER_STATES: AutoJumpTriggerStates = {
  /** 密着状態 */
  flush: false,
  /** 歩き状態 */
  walk: false,
  /** ダッシュ状態 */
  sprint: true,
};

/**
 * デバッグ設定
 */
export const AUTO_JUMP_DEBUG = {
  /** デバッグモード全体の有効/無効 */
  enabled: true,
  /** ジャンプ発動時にチャットへ詳細ログを送信 */
  chatOnJump: true,
  /** ブロック検知中にアクションバーへリアルタイムな到達tickを表示 */
  actionBarTracking: true,
};

// ==========================================
// 事前計算
// ==========================================

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

// ==========================================
// 状態管理
// ==========================================

interface AutoJumpState {
  /** 次に判定可能になるtick（最小クールダウン） */
  canJumpAfterTick: number;
  /** ジャンプ実行中フラグ（離陸して再着地するまで再ジャンプ不可） */
  isJumping: boolean;
  /** 完全に空中に離陸したかどうかのフラグ */
  hasLeftGround: boolean;
}

const autoJumpStates = new Map<string, AutoJumpState>();

// ==========================================
// レイキャスト & 判定ロジック
// ==========================================

export interface CornerRayDebug {
  name: string;
  hit: boolean;
  distance: number;
}

export interface NextStepInfo {
  /** プレイヤー位置からの直線幾何距離（ブロック数） */
  distanceFromPlayer: number;
  /** 登った段差（1段目のブロック）からの距離（ブロック数） */
  distanceFromLedge: number;
  /** 次の段差ブロック */
  block?: Block;
}

export interface RaycastDistanceResult {
  /** 最短衝突距離（衝突なしの場合は Infinity） */
  minDistance: number;
  /** 衝突したブロック（衝突なしの場合は undefined） */
  hitBlock?: Block;
  /** 各コーナーのレイキャスト結果詳細 */
  rayResults: CornerRayDebug[];
  /** 登った先（1ブロック上）の次の段差情報 */
  nextStep?: NextStepInfo;
}

/**
 * レイの始点(pos)と水平移動方向(dir)から、ヒットしたブロックの衝突面(hit.face)の平面との正確な進行方向距離を計算します。
 * MCPE-223452等による hit.faceLocation の座標ずれ・1m過剰見積もりを回避し、数学的に厳密な距離を算出します。
 */
export function calculateDistanceToHitFace(
  pos: Vector3,
  dir: Vector3,
  blockLoc: Vector3,
  face: Direction,
): number {
  let t = 0;

  switch (face) {
    case Direction.North:
      // 北面: Z = blockLoc.z
      t = Math.abs(dir.z) > 1e-5 ? (blockLoc.z - pos.z) / dir.z : 0;
      break;
    case Direction.South:
      // 南面: Z = blockLoc.z + 1.0
      t = Math.abs(dir.z) > 1e-5 ? (blockLoc.z + 1.0 - pos.z) / dir.z : 0;
      break;
    case Direction.West:
      // 西面: X = blockLoc.x
      t = Math.abs(dir.x) > 1e-5 ? (blockLoc.x - pos.x) / dir.x : 0;
      break;
    case Direction.East:
      // 東面: X = blockLoc.x + 1.0
      t = Math.abs(dir.x) > 1e-5 ? (blockLoc.x + 1.0 - pos.x) / dir.x : 0;
      break;
    default: {
      // 上面や下面などの例外時はブロックAABBとの最短水平距離にフォールバック
      const dx = Math.max(blockLoc.x - pos.x, 0, pos.x - (blockLoc.x + 1.0));
      const dz = Math.max(blockLoc.z - pos.z, 0, pos.z - (blockLoc.z + 1.0));
      t = Math.hypot(dx, dz);
      break;
    }
  }

  return Math.max(0, t);
}

/**
 * オートジャンプの対象外ブロック（階段、または飛び越えられないフェンス等）であるか判定します。
 * - "~~~_stairs": 階段はバニラでジャンプなしで登れるため無視
 * - "_fence": フェンスは通常ジャンプで飛び越えられないため、目標高度が1.5m未満なら無視
 *
 * @param block 判定対象ブロック
 * @returns 無視すべきブロックなら true
 */
export function isIgnoredBlock(block: Block): boolean {
  const typeId = block.typeId;

  // 階段（"~~~_stairs"）: バニラで歩行登坂可能なため無視
  if (typeId.endsWith("_stairs")) {
    return true;
  }

  // フェンス（"_fence"）: 目標ジャンプ高度が1.5m未満の場合は飛び越えられないため無視
  if (
    AUTO_JUMP_TARGET_HEIGHT < 1.5 &&
    (typeId.endsWith("_fence") || typeId.includes("_fence"))
  ) {
    return true;
  }

  return false;
}

/**
 * プレイヤーのAABBの4つの端（コーナー）から水平移動方向にレイキャストを飛ばし、
 * 次に当たりそうなブロックまでの最短距離を取得します。
 *
 * @param player 対象プレイヤー
 * @param vel 現在の速度ベクトル
 * @param speed 水平速度 (hypot(vel.x, vel.z))
 */
export function getDistanceToNextBlock(
  player: Player,
  vel: Vector3,
  speed: number,
): RaycastDistanceResult {
  const dir: Vector3 = {
    x: vel.x / speed,
    y: 0,
    z: vel.z / speed,
  };

  const loc = player.location;
  const halfW = AUTO_JUMP_AABB_HALF_WIDTH;
  const rayY = loc.y + AUTO_JUMP_RAY_Y_OFFSET;

  // プレイヤーAABBの4隅の座標と名称
  const cornerDefs: { name: string; pos: Vector3 }[] = [
    { name: "NW", pos: { x: loc.x - halfW, y: rayY, z: loc.z - halfW } },
    { name: "NE", pos: { x: loc.x + halfW, y: rayY, z: loc.z - halfW } },
    { name: "SW", pos: { x: loc.x - halfW, y: rayY, z: loc.z + halfW } },
    { name: "SE", pos: { x: loc.x + halfW, y: rayY, z: loc.z + halfW } },
  ];

  const options: BlockRaycastOptions = {
    maxDistance: AUTO_JUMP_MAX_RAY_DISTANCE,
    includePassableBlocks: false, // 草・花・松明等のすり抜けブロックは除外
    includeLiquidBlocks: false, // 水・溶岩は除外
  };

  let minDistance = Infinity;
  let hitBlock: Block | undefined = undefined;
  const rayResults: CornerRayDebug[] = [];

  // 密着時にレイキャストがブロック境界からすり抜けるのを防止するため、始点をわずかに後方へオフセット
  const BACK_OFFSET = 0.05;

  for (const { name, pos } of cornerDefs) {
    const startPos: Vector3 = {
      x: pos.x - dir.x * BACK_OFFSET,
      y: pos.y,
      z: pos.z - dir.z * BACK_OFFSET,
    };

    const hit = player.dimension.getBlockFromRay(startPos, dir, options);
    if (hit) {
      // 階段や飛び越えられないフェンスは無視
      if (isIgnoredBlock(hit.block)) {
        rayResults.push({ name, hit: false, distance: Infinity });
        continue;
      }

      // hit.faceLocation は環境や座標によって1mずれるバグ(MCPE-223452)があるため、
      // 衝突面(hit.face)の平面方程式から厳密な到達距離を算出
      const dist = calculateDistanceToHitFace(
        pos,
        dir,
        hit.block.location,
        hit.face,
      );

      rayResults.push({ name, hit: true, distance: dist });

      if (dist < minDistance) {
        minDistance = dist;
        hitBlock = hit.block;
      }
    } else {
      rayResults.push({ name, hit: false, distance: Infinity });
    }
  }

  // 登った先（1ブロック上）の次の段差レイキャスト
  const upperRayY = rayY + 1.0;
  const upperOptions: BlockRaycastOptions = {
    maxDistance: AUTO_JUMP_UPPER_RAY_MAX_DISTANCE,
    includePassableBlocks: false,
    includeLiquidBlocks: false,
  };

  let nextStepDistance = Infinity;
  let nextStepBlock: Block | undefined = undefined;

  for (const { pos } of cornerDefs) {
    const startPos: Vector3 = {
      x: pos.x - dir.x * BACK_OFFSET,
      y: upperRayY,
      z: pos.z - dir.z * BACK_OFFSET,
    };

    const hit = player.dimension.getBlockFromRay(startPos, dir, upperOptions);
    if (hit && !isIgnoredBlock(hit.block)) {
      const upperPos: Vector3 = { x: pos.x, y: upperRayY, z: pos.z };
      const dist = calculateDistanceToHitFace(
        upperPos,
        dir,
        hit.block.location,
        hit.face,
      );

      if (dist < nextStepDistance) {
        nextStepDistance = dist;
        nextStepBlock = hit.block;
      }
    }
  }

  let nextStep: NextStepInfo | undefined = undefined;
  if (isFinite(nextStepDistance) && nextStepBlock) {
    nextStep = {
      distanceFromPlayer: nextStepDistance,
      distanceFromLedge: Math.max(0, nextStepDistance - minDistance),
      block: nextStepBlock,
    };
  }

  return { minDistance, hitBlock, rayResults, nextStep };
}

export interface ForwardInputResult {
  /** 前方移動入力判定を満たしているか */
  isForward: boolean;
  /** 視線方向に対する入力ズレ角のsin値 */
  sinDiff: number;
  /** 生の入力ベクトル */
  inputVector?: { x: number; y: number };
  /** 判定ソース */
  source: "inputInfo" | "velocity" | "stationary_fallback";
}

/**
 * プレイヤーの移動入力（実際の移動速度ベクトルではなく入力そのもの）が、
 * 視線方向に対して前方（入力ズレ角のsin値 <= sin60°）であるかを判定します。
 *
 * @param player 対象プレイヤー
 * @returns 前方移動判定結果
 */
export function checkForwardMovementInput(player: Player): ForwardInputResult {
  try {
    if (player.inputInfo) {
      const moveVector = player.inputInfo.getMovementVector();
      const inputX = moveVector.x;
      const inputY = moveVector.y;
      const inputLen = Math.hypot(inputX, inputY);

      if (inputLen >= 0.05) {
        // 前方成分: 標準的なCartesian(inputY > 0)
        const isForwardY = inputY > 0;
        const sinDiff = Math.abs(inputX) / inputLen;
        const isForward =
          isForwardY && sinDiff <= AUTO_JUMP_FORWARD_SIN_THRESHOLD;

        return {
          isForward,
          sinDiff,
          inputVector: { x: inputX, y: inputY },
          source: "inputInfo",
        };
      }
    }
  } catch {
    // inputInfo 利用不可時のフォールバックへ
  }

  // inputInfo が使えない、または入力値がゼロ（静止/壁激突中）の場合
  const vel = player.getVelocity();
  const speed = Math.hypot(vel.x, vel.z);
  const viewDir = player.getViewDirection();
  const horizLen = Math.hypot(viewDir.x, viewDir.z);

  if (speed < 0.01 || horizLen <= 0) {
    // 完全静止・密着中: 速度ベクトルからは判定不能なため stationary_fallback として返し、
    // 密着判定(tryFlushAutoJump)側で視線方向・壁面位置と統合して最終判定する
    return {
      isForward: false,
      sinDiff: 0,
      source: "stationary_fallback",
    };
  }

  const normVx = viewDir.x / horizLen;
  const normVz = viewDir.z / horizLen;
  const normVelX = vel.x / speed;
  const normVelZ = vel.z / speed;

  const cosForward = normVx * normVelX + normVz * normVelZ;
  if (cosForward <= 0) {
    return { isForward: false, sinDiff: 1.0, source: "velocity" };
  }

  const sinDiff = Math.abs(normVx * normVelZ - normVz * normVelX);
  const isForward = sinDiff <= AUTO_JUMP_FORWARD_SIN_THRESHOLD;

  return { isForward, sinDiff, source: "velocity" };
}

/**
 * 対象ブロックの頭上にプレイヤーが登れる空間（クリアランス）があるか判定します。
 */
function hasClearanceAbove(block: Block): boolean {
  if (!AUTO_JUMP_CHECK_CLEARANCE) return true;

  const above1 = block.above(1);
  const above2 = block.above(2);

  const hasCollision1 = hasBlockCollisionFromAirFaces(above1);
  const hasCollision2 = hasBlockCollisionFromAirFaces(above2);

  return !hasCollision1 && !hasCollision2;
}

/**
 * 視線方向ベクトルから、最も近いプレイヤーAABBの面（東西南北の4方位）の単位ベクトルを取得します。
 *
 * @param viewDir 視線方向ベクトル
 * @returns AABB面の法線方向単位ベクトル (North: -Z, South: +Z, West: -X, East: +X)
 */
export function getClosestAABBFaceDirection(viewDir: Vector3): Vector3 {
  const absX = Math.abs(viewDir.x);
  const absZ = Math.abs(viewDir.z);

  if (absX > absZ) {
    return viewDir.x > 0 ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 };
  } else {
    return viewDir.z > 0 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 };
  }
}

/**
 * ジャンプインパルス付与・ダッシュ加速・ステート更新・デバッグ通知を一括実行する共通関数
 */
function executeAutoJump(
  player: Player,
  currentTick: number,
  state: AutoJumpState,
  hitBlock: Block,
  vel: Vector3,
  speed: number,
  triggerReason: string,
  extraDetails?: string,
  nextStep?: NextStepInfo,
): void {
  // クールダウンおよび離陸・着地監視ステートを設定
  state.canJumpAfterTick = currentTick + AUTO_JUMP_COOLDOWN_TICKS;
  state.isJumping = true;
  state.hasLeftGround = false;

  // 水平移動方向の単位ベクトルを算出
  let dirX = 0;
  let dirZ = 0;
  if (speed > 0.001) {
    dirX = vel.x / speed;
    dirZ = vel.z / speed;
  } else {
    const viewDir = player.getViewDirection();
    const viewLen = Math.hypot(viewDir.x, viewDir.z);
    if (viewLen > 0) {
      dirX = viewDir.x / viewLen;
      dirZ = viewDir.z / viewLen;
    }
  }

  // 1. Y方向インパルスを実行（浮き上がり高さ 1.05ブロック）
  const targetImpulseY = PRECALCULATED_LIFT.initialVelocityY - vel.y;
  const liftImpulseY = Math.min(
    PRECALCULATED_LIFT.initialVelocityY,
    Math.max(0, targetImpulseY),
  );

  player.applyImpulse({
    x: 0,
    y: liftImpulseY,
    z: 0,
  });

  // 2. ダッシュ中はジャンプ後にxz方向に0.2のボーナス加速を与える
  const isSprinting = player.isSprinting;
  if (isSprinting && (dirX !== 0 || dirZ !== 0)) {
    player.applyImpulse({
      x: dirX * AUTO_JUMP_SPRINT_BONUS,
      y: 0,
      z: dirZ * AUTO_JUMP_SPRINT_BONUS,
    });
  }

  // 3. 次の段差が近接（<= 2.1m）している場合、最高高度到達の次tickに逆方向XZインパルス（直前速度の30%）を付与
  const shouldBrake = Boolean(
    nextStep &&
    nextStep.block &&
    isFinite(nextStep.distanceFromLedge) &&
    nextStep.distanceFromLedge <= AUTO_JUMP_BRAKE_NEXT_STEP_DISTANCE,
  );

  if (shouldBrake) {
    const brakeTicks = AUTO_JUMP_BRAKE_DELAY_TICKS;
    system.runTimeout(() => {
      if (!player.isValid) return;

      // ブレーキ直前の現在の水平移動速度を取得
      const curVel = player.getVelocity();
      const curSpeed = Math.hypot(curVel.x, curVel.z);

      // 水平速度が存在する場合、その比率分を逆向きインパルスとして付与
      if (curSpeed > 0.001) {
        const impulseX = -curVel.x * AUTO_JUMP_BRAKE_RATIO;
        const impulseZ = -curVel.z * AUTO_JUMP_BRAKE_RATIO;
        const impulseMag = Math.hypot(impulseX, impulseZ);

        player.applyImpulse({
          x: impulseX,
          y: 0,
          z: impulseZ,
        });

        if (AUTO_JUMP_DEBUG.enabled && AUTO_JUMP_DEBUG.chatOnJump) {
          const afterSpeed = curSpeed * (1 - AUTO_JUMP_BRAKE_RATIO);
          player.sendMessage(
            `§c[AutoJump ブレーキ発動]§r §7+${brakeTicks}tick 減速: §e-${(AUTO_JUMP_BRAKE_RATIO * 100).toFixed(0)}%§r §7(インパルス: §e-${impulseMag.toFixed(3)}§r, 速度: §b${curSpeed.toFixed(3)}§7→§a${afterSpeed.toFixed(3)}§7, 次段差: §b${nextStep?.distanceFromLedge?.toFixed(2)}m§7)§r`,
          );
        }
      }
    }, brakeTicks);
  }

  // デバッグメッセージ送信
  if (AUTO_JUMP_DEBUG.enabled) {
    if (AUTO_JUMP_DEBUG.chatOnJump) {
      let nextStepStr = "  §7次の段差: §fなし(平坦)§r";
      if (nextStep && nextStep.block && isFinite(nextStep.distanceFromLedge)) {
        const bName = nextStep.block.typeId.replace("minecraft:", "");
        const brakeNotice = shouldBrake
          ? ` §c[ブレーキ予定: +${AUTO_JUMP_BRAKE_DELAY_TICKS}tick (-${(AUTO_JUMP_BRAKE_RATIO * 100).toFixed(0)}%)]§r`
          : "";
        nextStepStr = `  §7次の段差: §e${nextStep.distanceFromLedge.toFixed(2)}ブロック先§r §7(自位置から§b${nextStep.distanceFromPlayer.toFixed(2)}m§7, §f${bName}§7)§r${brakeNotice}`;
      }

      player.sendMessage(
        `§a[AutoJump 発動: ${triggerReason}]§r §7Block: §e${hitBlock.typeId.replace("minecraft:", "")}§r\n` +
          `  §7速度: §b${speed.toFixed(3)}§r §7| ダッシュ加速: ${isSprinting ? `§a+${AUTO_JUMP_SPRINT_BONUS}§r` : "§7なし§r"}${extraDetails ? `\n  ${extraDetails}` : ""}\n` +
          nextStepStr,
      );
    }

    if (AUTO_JUMP_DEBUG.actionBarTracking) {
      const brakeNoticeShort = shouldBrake
        ? ` §c[Brake +${AUTO_JUMP_BRAKE_DELAY_TICKS}t]§r`
        : "";
      const nextShort =
        nextStep && isFinite(nextStep.distanceFromLedge)
          ? ` §7| 次:§e${nextStep.distanceFromLedge.toFixed(1)}m§r${brakeNoticeShort}`
          : "";
      player.onScreenDisplay.setActionBar(
        `§a[AutoJump] JUMP! (${triggerReason})${nextShort}`,
      );
    }
  }
}

/**
 * 完全にブロックに接着（密着）して停止している場合の救済オートジャンプ判定。
 * プレイヤーの中心から、前進入力方向や最も近いAABB面の方角にレイキャストを照射し、
 * 密着状態かつ正面入力（または正面注視）であればジャンプを発動します。
 */
export function tryFlushAutoJump(
  player: Player,
  currentTick: number,
  state: AutoJumpState,
  vel: Vector3,
  speed: number,
  forwardInputResult?: ForwardInputResult,
): boolean {
  // 密着状態での発動が無効化されている場合はスキップ
  if (!AUTO_JUMP_TRIGGER_STATES.flush) {
    return false;
  }

  const inputCheck = forwardInputResult ?? checkForwardMovementInput(player);

  // 視線方向に最も近いAABB面（東西南北）の方角を算出
  const viewDir = player.getViewDirection();
  const faceDir = getClosestAABBFaceDirection(viewDir);

  // 前方移動モード時は、プレイヤーの正面入力（キー/スティック前倒し）を必須とする
  // 入力がない場合（静止放置）や後退・横移動時は絶対に発動させない
  if (AUTO_JUMP_DIRECTION_MODE === "forward_only" && !inputCheck.isForward) {
    return false;
  }

  // プレイヤー中心（足元中央 + Yオフセット）から一番視点方向の方角に近いAABB面の方向にレイキャストを照射
  const loc = player.location;
  const rayStart: Vector3 = {
    x: loc.x,
    y: loc.y + AUTO_JUMP_RAY_Y_OFFSET,
    z: loc.z,
  };

  // 浮動小数点誤差やすり抜けを防ぐため探索距離は余裕を持って1.2mとし、面までの幾何距離で密着判定を行う（step-upの実装知見）
  const options: BlockRaycastOptions = {
    maxDistance: 1.2,
    includePassableBlocks: false,
    includeLiquidBlocks: false,
  };

  const hit = player.dimension.getBlockFromRay(rayStart, faceDir, options);
  if (!hit) {
    return false;
  }

  // 衝突面までの厳密な幾何距離を算出
  const dist = calculateDistanceToHitFace(
    rayStart,
    faceDir,
    hit.block.location,
    hit.face,
  );

  // 距離判定: AABB半幅0.3m + 密着マージン0.1m = 0.40m（+バッファ0.01m = 0.41m以内）
  if (dist > 0.41) {
    return false;
  }

  // 階段（_stairs）や飛び越えられないフェンス（_fence）は無視
  if (isIgnoredBlock(hit.block)) {
    return false;
  }

  // 頭上クリアランスチェック
  if (!hasClearanceAbove(hit.block)) {
    if (AUTO_JUMP_DEBUG.enabled && AUTO_JUMP_DEBUG.actionBarTracking) {
      player.onScreenDisplay.setActionBar(
        `§c[AutoJump] 密着・登坂不可(頭上塞がり): §f${hit.block.typeId.replace("minecraft:", "")}`,
      );
    }
    return false;
  }

  // 登った先（1ブロック上）の次の段差レイキャスト（探索距離: AUTO_JUMP_UPPER_RAY_MAX_DISTANCE = 6.0m）
  const upperRayStart: Vector3 = {
    x: loc.x,
    y: rayStart.y + 1.0,
    z: loc.z,
  };

  const upperOptions: BlockRaycastOptions = {
    maxDistance: AUTO_JUMP_UPPER_RAY_MAX_DISTANCE,
    includePassableBlocks: false,
    includeLiquidBlocks: false,
  };

  let nextStep: NextStepInfo | undefined = undefined;
  const upperHit = player.dimension.getBlockFromRay(
    upperRayStart,
    faceDir,
    upperOptions,
  );
  if (upperHit && !isIgnoredBlock(upperHit.block)) {
    const uDist = calculateDistanceToHitFace(
      upperRayStart,
      faceDir,
      upperHit.block.location,
      upperHit.face,
    );
    nextStep = {
      distanceFromPlayer: uDist,
      distanceFromLedge: Math.max(0, uDist - dist),
      block: upperHit.block,
    };
  }

  // 条件成立！ジャンプを実行
  executeAutoJump(
    player,
    currentTick,
    state,
    hit.block,
    vel,
    speed,
    "密着接着",
    `§7距離: §a${dist.toFixed(2)}m§r (許容: 0.41m) §7| 面: §b${Direction[hit.face]} §7| ブロック: §e${hit.block.typeId.replace("minecraft:", "")}§r`,
    nextStep,
  );

  return true;
}

/**
 * オートジャンプの発動可否を判定し、条件を満たす場合にジャンプインパルスを付与します。
 *
 * @param player 対象プレイヤー
 * @returns ジャンプが実行された場合は true
 */
export function tryAutoJump(player: Player): boolean {
  if (!player.isValid) return false;

  const currentTick = system.currentTick;
  let state = autoJumpStates.get(player.id);
  if (!state) {
    state = { canJumpAfterTick: 0, isJumping: false, hasLeftGround: false };
    autoJumpStates.set(player.id, state);
  }

  // 1. 離陸・着地ステートマシンの更新
  // ジャンプ実行後は「完全に空中に離陸した後に再び地面に着地する」まで再発動を遮断
  // ※ 同期遅延やすり抜けで離陸判定が取れなかった場合のため、5tick経過後のタイムアウト復帰ガードを追加
  if (state.isJumping) {
    if (!player.isOnGround) {
      state.hasLeftGround = true;
    } else if (state.hasLeftGround) {
      // 離陸後に再び着地したため、ジャンプ状態を解除
      state.isJumping = false;
      state.hasLeftGround = false;
    } else if (currentTick > state.canJumpAfterTick + 5) {
      // タイムアウト解除
      state.isJumping = false;
      state.hasLeftGround = false;
    } else {
      // applyImpulse 直後の同期待ち（まだ離陸パケットが届いていない）
      return false;
    }
  }

  // 2. 基本発動条件チェック（接地していること、スニークしていないこと、クールダウン消化済み）
  if (
    !player.isOnGround ||
    player.isSneaking ||
    currentTick < state.canJumpAfterTick
  ) {
    return false;
  }

  // 3. 垂直速度安全ガード: 地上静止・歩行中は vel.y ≈ 0
  // vel.y > 0.05（明確に上昇中・ジャンプ中）なら多重発動防止のためスキップ（微小な浮動小数点ノイズによる誤遮断を防止）
  const vel = player.getVelocity();
  if (vel.y > 0.05) {
    return false;
  }

  const speed = Math.hypot(vel.x, vel.z);
  const forwardInputResult = checkForwardMovementInput(player);

  // 4. 移動速度が最小値以上あれば、通常の先行予測オートジャンプ（4隅レイキャスト + 到達tick判定）を試行
  if (speed >= AUTO_JUMP_MIN_SPEED) {
    const isSprinting = player.isSprinting;
    const isStateAllowed = isSprinting
      ? AUTO_JUMP_TRIGGER_STATES.sprint
      : AUTO_JUMP_TRIGGER_STATES.walk;

    if (isStateAllowed) {
      // 移動中かつ前方移動モードの場合は、進行方向への前進入力を要求
      if (
        AUTO_JUMP_DIRECTION_MODE === "forward_only" &&
        !forwardInputResult.isForward
      ) {
        return false;
      }

      const { minDistance, hitBlock, rayResults, nextStep } =
        getDistanceToNextBlock(player, vel, speed);
      if (isFinite(minDistance) && hitBlock) {
        // 壁など登れないブロック（上に空きがない場合）はスキップ
        if (!hasClearanceAbove(hitBlock)) {
          if (AUTO_JUMP_DEBUG.enabled && AUTO_JUMP_DEBUG.actionBarTracking) {
            player.onScreenDisplay.setActionBar(
              `§c[AutoJump] 登坂不可(頭上塞がり): §f${hitBlock.typeId.replace("minecraft:", "")} §7距離: §e${minDistance.toFixed(2)}m`,
            );
          }
          return false;
        }

        // プレイヤーのベロシティからそのブロックまで到達するtickを計算
        const ticksToReach = minDistance / speed;

        // 到達tickが閾値より短いなら先行予測ジャンプを実行
        if (ticksToReach < PRECALCULATED_LIFT.ticksToApex) {
          const hitsSummary = rayResults
            .filter((r) => r.hit)
            .map((r) => `${r.name}:${r.distance.toFixed(2)}m`)
            .join(" ");

          const forwardDetail = `§7距離: §f${minDistance.toFixed(2)}m§r §7| 到達: §c${ticksToReach.toFixed(1)}t§r < §a${PRECALCULATED_LIFT.ticksToApex}t§r §7| 命中レイ: §d[${hitsSummary}]§r`;

          executeAutoJump(
            player,
            currentTick,
            state,
            hitBlock,
            vel,
            speed,
            isSprinting ? "先行予測(ダッシュ)" : "先行予測(歩き)",
            forwardDetail,
            nextStep,
          );
          return true;
        }

        // まだ到達タイミングではない（十分遠い）場合
        if (AUTO_JUMP_DEBUG.enabled && AUTO_JUMP_DEBUG.actionBarTracking) {
          player.onScreenDisplay.setActionBar(
            `§e[AutoJump] 検知中: §f${hitBlock.typeId.replace("minecraft:", "")} §7距離: §e${minDistance.toFixed(2)}m §7| 到達: §b${ticksToReach.toFixed(1)}t §7>= 閾値: §a${PRECALCULATED_LIFT.ticksToApex}t`,
          );
        }
      }
    }
  }

  // 5. 完全にブロックに接着（密着）して停止している場合の判定
  if (AUTO_JUMP_TRIGGER_STATES.flush) {
    return tryFlushAutoJump(
      player,
      currentTick,
      state,
      vel,
      speed,
      forwardInputResult,
    );
  }

  return false;
}

// ==========================================
// 初期化・イベント購読
// ==========================================

/**
 * オートジャンプ機能のメインループを開始します。
 */
export function autoJumpMain(): void {
  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      tryAutoJump(player);
    }
  }, 1);

  world.afterEvents.playerLeave.subscribe((event) => {
    autoJumpStates.delete(event.playerId);
  });
}
