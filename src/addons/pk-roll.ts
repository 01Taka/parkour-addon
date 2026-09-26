import {
  world,
  system,
  Player,
  EntityDamageCause,
  type BlockRaycastOptions,
  type Vector3,
} from "@minecraft/server";
import { parkourEventHandler } from "../utils/parkour-event-handler.class";

// ==========================================
// 定数・パラメータ設定
// ==========================================

/** 視線方向のY成分の許容上限（水平より下を向いていること） */
export const ROLL_VIEW_MAX_DIRECTION_Y = 0.0;

/** 視線方向XZと移動速度XZの最大角度ズレのsin閾値 */
export const ROLL_MAX_DIRECTION_SIN_THRESHOLD = Math.sin((45 * Math.PI) / 180);

/** 下方向へのレイキャスト最大距離 */
export const ROLL_DOWNWARD_RAY_MAX_DISTANCE = 2.5;

/** かかと位置のオフセット距離（視線後方へのXZ移動量） */
export const ROLL_HEEL_OFFSET_XZ = 0.3;

/** パルクールロール発動可能時間（持続フレーム数 / tick） */
export const ROLL_WINDOW_TICKS = 6;

/** 再度発動可能になるまでのクールダウン（tick） */
export const ROLL_COOLDOWN_TICKS = 20;

/** 落下ダメージ軽減量 */
export const ROLL_FALL_DAMAGE_REDUCTION = 2;

/**
 * 落下ダメージ発生後のPKロール入力猶予パディング（tick数）
 * ゼロが指定されている場合は、発動可能時間中に受けたダメージを直接軽減
 */
export const ROLL_FALL_PADDING_TICKS = 1;

/** ロール発動時の前方インパルス強度 */
export const ROLL_IMPULSE_FORWARD = 0.5;

/** ロール発動時の下方向インパルス強度 */
export const ROLL_IMPULSE_DOWNWARD = 0.15;

/** デバッグ用: 真下レイ未ヒット時に何メートル先ならヒットするかを計測するための最大探索距離 */
export const ROLL_DEBUG_RAY_MAX_DISTANCE = 12.0;

/**
 * 下方向へのレイキャスト設定
 * 水や草・花などのすり抜け可能ブロックを除外
 */
export const ROLL_DOWNWARD_RAYCAST_OPTIONS: BlockRaycastOptions = {
  maxDistance: ROLL_DOWNWARD_RAY_MAX_DISTANCE,
  includePassableBlocks: false, // 草・花・松明などは除外
  includeLiquidBlocks: false, // 水や溶岩などは除外
};

// ==========================================
// 状態管理
// ==========================================

interface RollState {
  /** 発動したtick */
  triggeredAtTick: number;
  /** パルクールロール発動可能時間（このtickまで有効） */
  activeUntilTick: number;
  /** 次に再発動可能になるtick（クールダウン） */
  canTriggerAfterTick: number;
}

interface PendingFallDamage {
  /** 保留された落下ダメージ量 */
  damage: number;
  /** 落下ダメージを受けたtick */
  hurtTick: number;
  /** パディング期限切れとなるtick */
  expiresAtTick: number;
  /** タイマーID */
  timeoutId?: number;
}

const rollStates = new Map<string, RollState>();
const pendingFallDamages = new Map<string, PendingFallDamage>();
const isApplyingCustomFallDamage = new Set<string>();

/**
 * 指定したプレイヤーがパルクールロール発動可能時間中（有効状態）であるかを判定します。
 */
export function isPkRollActive(player: Player): boolean {
  const state = rollStates.get(player.id);
  if (!state) return false;
  return system.currentTick <= state.activeUntilTick;
}

// ==========================================
// アクション判定・実行
// ==========================================

/**
 * パルクールロールの発動可否を判定し、条件を満たす場合に有効状態にします。
 * 落下ダメージ保留中の場合は、保留ダメージに対して軽減とロールインパルスを適用します。
 * 発動条件のうち満たされないものがあれば、すべて一覧にしてプレイヤーへメッセージを送信します。
 *
 * 発動条件:
 * 1. プレイヤーのY方向速度が負であること (vel.y < 0) ※保留ダメージがある場合は免除
 * 2. クールダウンが経過していること
 * 3. かかと位置から下方向のレイが固体ブロックにヒットすること
 * 4. 視線が水平より下を向いていること (viewDir.y <= ROLL_VIEW_MAX_DIRECTION_Y)
 * 5. 視線方向XZと移動速度XZのズレ（sin）が許容閾値以内であること
 */
export function tryTriggerPkRoll(player: Player): boolean {
  const currentTick = system.currentTick;
  const state = rollStates.get(player.id);

  // すでにロール発動可能時間（有効状態）中である場合は重複発火やエラー出力をスキップ
  if (state && currentTick <= state.activeUntilTick) {
    return false;
  }

  const pending = pendingFallDamages.get(player.id);
  const hasPendingDamage =
    pending !== undefined && currentTick <= pending.expiresAtTick;

  const vel = player.getVelocity();
  const unmetConditions: string[] = [];

  // 1. Y方向の速度が負であること（下降中）
  // 着地後の保留期間中は地面接触でY速度が0になるため、保留中であればチェックを自動通過
  if (!hasPendingDamage && vel.y >= 0) {
    unmetConditions.push(
      `Y方向の速度が負ではない (vel.y: ${vel.y.toFixed(3)} >= 0)`,
    );
  }

  // 2. クールダウン判定
  if (state && currentTick < state.canTriggerAfterTick) {
    const remainingTicks = state.canTriggerAfterTick - currentTick;
    unmetConditions.push(`再発動クールダウン中 (残り: ${remainingTicks} tick)`);
  }

  // 3. かかと位置（視線後方XZオフセット）から下方向にレイを飛ばす（水や草はすり抜ける）
  const viewDir = player.getViewDirection();
  const horizLen = Math.hypot(viewDir.x, viewDir.z);
  const normX = horizLen > 0 ? viewDir.x / horizLen : 0;
  const normZ = horizLen > 0 ? viewDir.z / horizLen : 0;

  const downwardRayStart: Vector3 = {
    x: player.location.x - normX * ROLL_HEEL_OFFSET_XZ,
    y: player.location.y + 0.1, // 足元がブロック上面と一致している場合の境界抜けを防止
    z: player.location.z - normZ * ROLL_HEEL_OFFSET_XZ,
  };
  const downwardRayDirection: Vector3 = { x: 0, y: -1, z: 0 };

  const downwardHit = player.dimension.getBlockFromRay(
    downwardRayStart,
    downwardRayDirection,
    ROLL_DOWNWARD_RAYCAST_OPTIONS,
  );

  if (!downwardHit) {
    // デバッグ用計測: 長距離探索を行い、真下何メートル先ならブロックが存在するかを算出
    const debugDownwardHit = player.dimension.getBlockFromRay(
      downwardRayStart,
      downwardRayDirection,
      {
        ...ROLL_DOWNWARD_RAYCAST_OPTIONS,
        maxDistance: ROLL_DEBUG_RAY_MAX_DISTANCE,
      },
    );

    if (debugDownwardHit) {
      const worldHitY =
        debugDownwardHit.block.location.y + debugDownwardHit.faceLocation.y;
      const downwardDist = player.location.y - worldHitY;
      const blockName = debugDownwardHit.block.typeId.replace("minecraft:", "");

      unmetConditions.push(
        `下方向レイが判定距離(${ROLL_DOWNWARD_RAY_MAX_DISTANCE.toFixed(2)}m)内にヒットしない ` +
          `[Debug計測: 足元から真下 ${downwardDist.toFixed(2)}m でブロック検出 (${blockName})]`,
      );
    } else {
      unmetConditions.push(
        `下方向レイが判定距離(${ROLL_DOWNWARD_RAY_MAX_DISTANCE.toFixed(2)}m)内にヒットしない ` +
          `[Debug計測: 探査限界(${ROLL_DEBUG_RAY_MAX_DISTANCE.toFixed(1)}m)内にもブロックなし]`,
      );
    }
  }

  // 4. 視線が水平より下を向いていること
  if (viewDir.y > ROLL_VIEW_MAX_DIRECTION_Y) {
    unmetConditions.push(
      `視線が水平より下ではない (viewDir.y: ${viewDir.y.toFixed(3)} > ${ROLL_VIEW_MAX_DIRECTION_Y})`,
    );
  }

  // 5. 視線方向XZと移動速度XZのズレ（sin）が許容閾値（sin30°）以内であること
  const speedXZ = Math.hypot(vel.x, vel.z);
  if (speedXZ >= 0.001 && horizLen > 0) {
    const normVelX = vel.x / speedXZ;
    const normVelZ = vel.z / speedXZ;

    // 2D外積の絶対値（sin値）と内積（前進成分: cos値）
    const sinDiff = Math.abs(normX * normVelZ - normZ * normVelX);
    const cosForward = normX * normVelX + normZ * normVelZ;

    if (cosForward <= 0 || sinDiff > ROLL_MAX_DIRECTION_SIN_THRESHOLD) {
      unmetConditions.push(
        `移動方向と視線のズレが許容範囲外 (sin: ${sinDiff.toFixed(3)}, 許容: <= ${ROLL_MAX_DIRECTION_SIN_THRESHOLD.toFixed(3)}, cos: ${cosForward.toFixed(3)})`,
      );
    }
  }

  // 満たされない条件がある場合は一覧を送信して中断
  if (unmetConditions.length > 0) {
    player.sendMessage(
      `§c[Roll 不発] 未達成条件 (${unmetConditions.length}件):\n` +
        unmetConditions.map((cond) => ` §c- §f${cond}`).join("\n"),
    );
    return false;
  }

  // --- 発動成功処理 ---

  // ケースA: 保留中の落下ダメージが存在する場合（パディング時間内の成功）
  if (hasPendingDamage && pending) {
    if (pending.timeoutId !== undefined) {
      system.clearRun(pending.timeoutId);
    }
    pendingFallDamages.delete(player.id);

    const delayTicks = currentTick - pending.hurtTick;
    const reducedDamage = pending.damage - ROLL_FALL_DAMAGE_REDUCTION;

    // クールダウン設定
    rollStates.set(player.id, {
      triggeredAtTick: currentTick,
      activeUntilTick: -1,
      canTriggerAfterTick: currentTick + ROLL_COOLDOWN_TICKS,
    });

    // 斜め下前へのロールインパルスを付与
    applyRollImpulse(player);

    if (reducedDamage <= 0) {
      player.sendMessage(
        `§a[Roll 軽減] パディング時間内にロール成功！ 落下ダメージ無効化 (Tick: ${currentTick}, 着地から: ${delayTicks} ticks, 元ダメージ: ${pending.damage.toFixed(1)} -> 0)`,
      );
    } else {
      player.sendMessage(
        `§a[Roll 軽減] パディング時間内にロール成功！ 落下ダメージ軽減 (Tick: ${currentTick}, 着地から: ${delayTicks} ticks, 元ダメージ: ${pending.damage.toFixed(1)} -> ${reducedDamage.toFixed(1)}, -${ROLL_FALL_DAMAGE_REDUCTION})`,
      );

      // 軽減後の残余ダメージを付与
      isApplyingCustomFallDamage.add(player.id);
      player.applyDamage(reducedDamage, {
        cause: EntityDamageCause.fall,
      });
    }

    return true;
  }

  // ケースB: 先行入力（通常の着地前発動可能状態への遷移）
  rollStates.set(player.id, {
    triggeredAtTick: currentTick,
    activeUntilTick: currentTick + ROLL_WINDOW_TICKS,
    canTriggerAfterTick: currentTick + ROLL_COOLDOWN_TICKS,
  });

  const downwardTargetName = downwardHit
    ? downwardHit.block.typeId.replace("minecraft:", "")
    : "block";

  player.sendMessage(
    `§a[Roll] 発動可能状態になりました！ (Tick: ${currentTick} / 有効: Tick ${currentTick + ROLL_WINDOW_TICKS} まで / CD: ${ROLL_COOLDOWN_TICKS} ticks, 足元: ${downwardTargetName})`,
  );
  return true;
}

/**
 * パルクールロールのロールインパルス（斜め下前）をプレイヤーに付与します。
 *
 * @param player 対象プレイヤー
 */
export function applyRollImpulse(player: Player): void {
  const viewDir = player.getViewDirection();
  const horizLen = Math.hypot(viewDir.x, viewDir.z);
  const forwardX =
    horizLen > 0 ? (viewDir.x / horizLen) * ROLL_IMPULSE_FORWARD : 0;
  const forwardZ =
    horizLen > 0 ? (viewDir.z / horizLen) * ROLL_IMPULSE_FORWARD : 0;

  const impulse: Vector3 = {
    x: forwardX,
    y: -ROLL_IMPULSE_DOWNWARD,
    z: forwardZ,
  };

  // beforeEvents の restricted-execution モードを避けて安全に適用するため system.run を使用
  system.run(() => {
    if (!player.isValid) return;
    player.applyImpulse(impulse);
  });
}

// ==========================================
// メイン初期化
// ==========================================

export function pkRollMain(): void {
  // 1. スイング開始イベント購読（腕を振った瞬間に即座に判定）
  parkourEventHandler.onSwingStart.subscribe(({ player }) => {
    tryTriggerPkRoll(player);
  });

  // 2. 落下ダメージ軽減処理
  world.beforeEvents.entityHurt.subscribe((event) => {
    // 落下ダメージのみを対象とする
    if (event.damageSource.cause !== "fall") return;

    if (!(event.hurtEntity instanceof Player)) return;
    const player = event.hurtEntity;
    if (!player.isValid) return;

    // プログラム自身が保留解除後に与えたダメージはスルーして無限ループを防止
    if (isApplyingCustomFallDamage.has(player.id)) {
      isApplyingCustomFallDamage.delete(player.id);
      return;
    }

    const currentTick = system.currentTick;
    const state = rollStates.get(player.id);
    const originalDamage = event.damage;

    // 既にロール発動可能時間（有効状態）である場合: 即座に直接軽減
    if (state && currentTick <= state.activeUntilTick) {
      const elapsedSinceTrigger = currentTick - state.triggeredAtTick;
      const reducedDamage = originalDamage - ROLL_FALL_DAMAGE_REDUCTION;

      if (reducedDamage <= 0) {
        event.cancel = true;
        player.sendMessage(
          `§a[Roll 軽減] 先行入力ロール成功！ 落下ダメージ無効化 (Tick: ${currentTick}, 発動から: ${elapsedSinceTrigger} ticks, 元ダメージ: ${originalDamage.toFixed(1)} -> 0)`,
        );
      } else {
        event.damage = reducedDamage;
        player.sendMessage(
          `§a[Roll 軽減] 先行入力ロール成功！ 落下ダメージ軽減 (Tick: ${currentTick}, 発動から: ${elapsedSinceTrigger} ticks, 元ダメージ: ${originalDamage.toFixed(1)} -> ${reducedDamage.toFixed(1)}, -${ROLL_FALL_DAMAGE_REDUCTION})`,
        );
      }

      // 斜め下前へのロールインパルスを付与
      applyRollImpulse(player);

      // ダメージ軽減適用後は発動可能時間を終了（クールダウンは維持）
      state.activeUntilTick = -1;
      return;
    }

    // パディングが無効（ゼロ以下）の場合: 即時判定のみ行い、未発動なら通常ダメージを通す
    if (ROLL_FALL_PADDING_TICKS <= 0) {
      if (!state) {
        player.sendMessage(
          `§c[Roll 軽減不発] 落下ダメージ発生！ (Tick: ${currentTick}) ロール未発動です (ダメージ: ${originalDamage.toFixed(1)})`,
        );
      } else {
        const elapsedSinceTrigger = currentTick - state.triggeredAtTick;
        const expiredTicksAgo = currentTick - state.activeUntilTick;
        player.sendMessage(
          `§c[Roll 軽減不発] 落下ダメージ発生！ (Tick: ${currentTick}) 有効時間切れです (発動Tick: ${state.triggeredAtTick}, 経過: ${elapsedSinceTrigger} ticks, 期限から ${expiredTicksAgo} ticks 超過, ダメージ: ${originalDamage.toFixed(1)})`,
        );
      }
      return;
    }

    // パディングが有効な場合: 落下ダメージを完全に無効化して保留
    event.cancel = true;

    // 既存の保留タイマーがあれば解除
    const existing = pendingFallDamages.get(player.id);
    if (existing && existing.timeoutId !== undefined) {
      system.clearRun(existing.timeoutId);
    }

    const expiresAtTick = currentTick + ROLL_FALL_PADDING_TICKS;

    player.sendMessage(
      `§e[Roll 保留] 落下ダメージ発生！ (Tick: ${currentTick}) パディング待機中... (ダメージ: ${originalDamage.toFixed(1)}, 猶予: ${ROLL_FALL_PADDING_TICKS} ticks)`,
    );

    // パディング期間満了時にロールが発動されなかった場合、元のダメージを付与するタイマー
    const timeoutId = system.runTimeout(() => {
      const pending = pendingFallDamages.get(player.id);
      if (!pending) return;
      pendingFallDamages.delete(player.id);

      if (!player.isValid) return;

      player.sendMessage(
        `§c[Roll 不発] パディング時間内にロールが入力されませんでした (Tick: ${system.currentTick}, ダメージ: ${pending.damage.toFixed(1)})`,
      );

      // プログラムから本来の落下ダメージを与える
      isApplyingCustomFallDamage.add(player.id);
      player.applyDamage(pending.damage, {
        cause: EntityDamageCause.fall,
      });
    }, ROLL_FALL_PADDING_TICKS);

    pendingFallDamages.set(player.id, {
      damage: originalDamage,
      hurtTick: currentTick,
      expiresAtTick,
      timeoutId,
    });
  });

  // 3. プレイヤー切断時のクリーンアップ
  world.afterEvents.playerLeave.subscribe((event) => {
    rollStates.delete(event.playerId);
    const pending = pendingFallDamages.get(event.playerId);
    if (pending && pending.timeoutId !== undefined) {
      system.clearRun(pending.timeoutId);
    }
    pendingFallDamages.delete(event.playerId);
    isApplyingCustomFallDamage.delete(event.playerId);
  });
}
