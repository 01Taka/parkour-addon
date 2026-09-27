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
 * オートジャンプ判定を行う最小水平速度（ブロック/tick）
 */
export const AUTO_JUMP_MIN_SPEED = 0.02;

/**
 * オートジャンプ発動後の再発動クールダウン（tick）
 */
export const AUTO_JUMP_COOLDOWN_TICKS = 8;

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

export interface RaycastDistanceResult {
  /** 最短衝突距離（衝突なしの場合は Infinity） */
  minDistance: number;
  /** 衝突したブロック（衝突なしの場合は undefined） */
  hitBlock?: Block;
  /** 各コーナーのレイキャスト結果詳細 */
  rayResults: CornerRayDebug[];
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

  return { minDistance, hitBlock, rayResults };
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
): void {
  // クールダウンおよび離陸・着地監視ステートを設定
  state.canJumpAfterTick = currentTick + AUTO_JUMP_COOLDOWN_TICKS;
  state.isJumping = true;
  state.hasLeftGround = false;

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
  if (isSprinting) {
    let boostX = 0;
    let boostZ = 0;
    if (speed > 0.001) {
      boostX = vel.x / speed;
      boostZ = vel.z / speed;
    } else {
      const viewDir = player.getViewDirection();
      const viewLen = Math.hypot(viewDir.x, viewDir.z);
      if (viewLen > 0) {
        boostX = viewDir.x / viewLen;
        boostZ = viewDir.z / viewLen;
      }
    }

    player.applyImpulse({
      x: boostX * AUTO_JUMP_SPRINT_BONUS,
      y: 0,
      z: boostZ * AUTO_JUMP_SPRINT_BONUS,
    });
  }

  // デバッグメッセージ送信
  if (AUTO_JUMP_DEBUG.enabled) {
    if (AUTO_JUMP_DEBUG.chatOnJump) {
      player.sendMessage(
        `§a[AutoJump 発動: ${triggerReason}]§r §7Block: §e${hitBlock.typeId.replace("minecraft:", "")}§r\n` +
          `  §7速度: §b${speed.toFixed(3)}§r §7| ダッシュ加速: ${isSprinting ? `§a+${AUTO_JUMP_SPRINT_BONUS}§r` : "§7なし§r"}${extraDetails ? `\n  ${extraDetails}` : ""}`,
      );
    }

    if (AUTO_JUMP_DEBUG.actionBarTracking) {
      player.onScreenDisplay.setActionBar(
        `§a[AutoJump] JUMP! (${triggerReason})`,
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
  const inputCheck = forwardInputResult ?? checkForwardMovementInput(player);

  // 視線水平ベクトル
  const viewDir = player.getViewDirection();
  const viewLen = Math.hypot(viewDir.x, viewDir.z);
  const normVx = viewLen > 0 ? viewDir.x / viewLen : 0;
  const normVz = viewLen > 0 ? viewDir.z / viewLen : 0;

  // 視線方向に最も近いAABB面（東西南北）の方角を算出
  const faceDir = getClosestAABBFaceDirection(viewDir);

  // 入力が正面であるかの検証:
  // 1. inputInfoでisForward判定が取れている場合はOK
  // 2. inputInfoで入力ベクトルが存在し、軸比率で正面寄り（sin <= 60°）ならOK
  // 3. inputInfoが取得できない環境（stationary_fallback等）や壁衝突で入力が0になる場合:
  //    視線が壁面方向（faceDir）を向いている（dot(viewDir, faceDir) >= cos(60°) = 0.5）かつスニークしていなければ正面入力とみなす
  let isForwardIntent = inputCheck.isForward;

  if (!isForwardIntent && inputCheck.inputVector) {
    const { x: inX, y: inY } = inputCheck.inputVector;
    const len = Math.hypot(inX, inY);
    if (len >= 0.05 && Math.abs(inX) / len <= AUTO_JUMP_FORWARD_SIN_THRESHOLD) {
      isForwardIntent = true;
    }
  }

  if (
    !isForwardIntent &&
    (inputCheck.source === "stationary_fallback" || !inputCheck.inputVector)
  ) {
    const dotViewFace = normVx * faceDir.x + normVz * faceDir.z;
    if (dotViewFace >= 0.5) {
      isForwardIntent = true;
    }
  }

  if (!isForwardIntent && AUTO_JUMP_DIRECTION_MODE === "forward_only") {
    return false;
  }

  // プレイヤー中心（足元中央 + Yオフセット）から一番視点方向の方角に近いAABB面の方向にレイキャストを照射
  const loc = player.location;
  const rayStart: Vector3 = {
    x: loc.x,
    y: loc.y + AUTO_JUMP_RAY_Y_OFFSET,
    z: loc.z,
  };

  // 長さ0.35m（AABB半幅0.3m + 密着マージン0.05m）のレイキャスト
  const options: BlockRaycastOptions = {
    maxDistance: 0.35,
    includePassableBlocks: false,
    includeLiquidBlocks: false,
  };

  const hit = player.dimension.getBlockFromRay(rayStart, faceDir, options);
  if (!hit) {
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

  // 条件成立！ジャンプを実行
  executeAutoJump(
    player,
    currentTick,
    state,
    hit.block,
    vel,
    speed,
    "密着接着",
    `§7面方向: §b${Direction[hit.face]} §7| ブロック: §e${hit.block.typeId.replace("minecraft:", "")}§r`,
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

  // 3. 垂直速度安全ガード: 地上静止・歩行中は vel.y == 0
  // vel.y > 0（すでに上昇中・ジャンプ中）なら多重発動防止のため絶対にスキップ
  const vel = player.getVelocity();
  if (vel.y > 0) {
    return false;
  }

  const speed = Math.hypot(vel.x, vel.z);
  const forwardInputResult = checkForwardMovementInput(player);

  // 4. 移動速度が最小値以上あれば、通常の先行予測オートジャンプ（4隅レイキャスト + 到達tick判定）を試行
  if (speed >= AUTO_JUMP_MIN_SPEED) {
    // 移動中かつ前方移動モードの場合は、進行方向への前進入力を要求
    if (
      AUTO_JUMP_DIRECTION_MODE === "forward_only" &&
      !forwardInputResult.isForward
    ) {
      return false;
    }

    const { minDistance, hitBlock, rayResults } = getDistanceToNextBlock(
      player,
      vel,
      speed,
    );
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
          "先行予測",
          forwardDetail,
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

  // 5. 完全にブロックに接着（密着）して停止している場合の判定
  return tryFlushAutoJump(
    player,
    currentTick,
    state,
    vel,
    speed,
    forwardInputResult,
  );
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
