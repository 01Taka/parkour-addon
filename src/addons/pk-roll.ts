import {
  world,
  system,
  Player,
  EntityDamageCause,
  EquipmentSlot,
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
// ダメージ・エンチャント補正計算
// ==========================================

/**
 * プレイヤーの防具エンチャント（落下耐性・ダメージ軽減）および耐性エフェクトから
 * 落下ダメージに対する被ダメージ倍率を算出します。
 *
 * @param player 対象プレイヤー
 * @returns 実際の被ダメージ倍率
 */
export function calculateFallDamageMultiplier(player: Player): number {
  let totalEPF = 0;

  const equippable = player.getComponent("minecraft:equippable");
  if (equippable) {
    const armorSlots = [
      EquipmentSlot.Head,
      EquipmentSlot.Chest,
      EquipmentSlot.Legs,
      EquipmentSlot.Feet,
    ];

    for (const slot of armorSlots) {
      const item = equippable.getEquipment(slot);
      if (!item) continue;

      const enchantable = item.getComponent("minecraft:enchantable");
      if (!enchantable) continue;

      for (const ench of enchantable.getEnchantments()) {
        const id = ench.type.id.replace("minecraft:", "");
        if (id === "feather_falling") {
          totalEPF += ench.level * 3;
        } else if (id === "protection") {
          totalEPF += ench.level * 1;
        }
      }
    }
  }

  // Bedrock の EPF キャップ（最大80%軽減）を適用
  const cappedEPF = Math.min(20, totalEPF);
  const epfDamageMultiplier = 1.0 - cappedEPF * 0.04;

  // 耐性エフェクト（Resistance）の考慮
  let resistanceMultiplier = 1.0;
  const resistanceEffect = player.getEffect("resistance");
  if (resistanceEffect) {
    const reduction = Math.min(1.0, (resistanceEffect.amplifier + 1) * 0.2);
    resistanceMultiplier = 1.0 - reduction;
  }

  return Math.max(0.0001, epfDamageMultiplier * resistanceMultiplier);
}

/**
 * エンチャント適用後の最終ダメージから定数軽減量を差し引くために、
 * 適用前の生ダメージ（Raw Damage）から差し引くべき補正量を計算します。
 *
 * @param player 対象プレイヤー
 * @returns 生ダメージから差し引くべき軽減量
 */
export function calculateRawFallDamageReduction(player: Player): number {
  const multiplier = calculateFallDamageMultiplier(player);
  return ROLL_FALL_DAMAGE_REDUCTION / multiplier;
}

// ==========================================
// アクション判定・実行
// ==========================================

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

/**
 * パルクールロールの発動可否を判定し、条件を満たす場合にアクションを実行します。
 * 軽量かつ不発頻度が高い判定から順に評価し、早期リターンします。
 *
 * 発動条件:
 * 1. すでにロール有効時間内ではないこと
 * 2. クールダウンが経過していること
 * 3. プレイヤーのY方向速度が負であること (vel.y < 0) ※保留ダメージがある場合は免除
 * 4. 視線が水平より下を向いていること (viewDir.y <= ROLL_VIEW_MAX_DIRECTION_Y)
 * 5. 視線方向XZと移動速度XZのズレ（sin）が許容閾値以内であること
 * 6. かかと位置から下方向のレイが固体ブロックにヒットすること
 */
export function tryTriggerPkRoll(player: Player): boolean {
  const currentTick = system.currentTick;
  const state = rollStates.get(player.id);

  // 1. すでにロール発動可能時間（有効状態）中である場合はスキップ
  if (state && currentTick <= state.activeUntilTick) {
    return false;
  }

  // 2. クールダウン判定（数値比較のみで最軽量）
  if (state && currentTick < state.canTriggerAfterTick) {
    return false;
  }

  // 保留中の落下ダメージ情報を取得
  const pending = pendingFallDamages.get(player.id);
  const hasPendingDamage =
    pending !== undefined && currentTick <= pending.expiresAtTick;

  // 3. Y方向の速度判定（下降中であること。着地保留中は0になるため免除）
  const vel = player.getVelocity();
  if (!hasPendingDamage && vel.y >= 0) {
    return false;
  }

  // 4. 視線方向のY成分判定（水平より下を向いていること）
  const viewDir = player.getViewDirection();
  if (viewDir.y > ROLL_VIEW_MAX_DIRECTION_Y) {
    return false;
  }

  // 5. 視線方向XZと移動速度XZのズレ判定（水平移動がある場合のみ外積計算）
  const speedXZ = Math.hypot(vel.x, vel.z);
  const horizLen = Math.hypot(viewDir.x, viewDir.z);
  if (speedXZ >= 0.001 && horizLen > 0) {
    const normVx = viewDir.x / horizLen;
    const normVz = viewDir.z / horizLen;
    const normVelX = vel.x / speedXZ;
    const normVelZ = vel.z / speedXZ;

    const sinDiff = Math.abs(normVx * normVelZ - normVz * normVelX);
    const cosForward = normVx * normVelX + normVz * normVelZ;

    // 前進成分が負（後ろ向き）またはsinズレが閾値を超えている場合は除外
    if (cosForward <= 0 || sinDiff > ROLL_MAX_DIRECTION_SIN_THRESHOLD) {
      return false;
    }
  }

  // 6. かかと位置から下方向へのレイキャスト（最も高コストなため全条件通過後に実行）
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
    return false;
  }

  // --- すべての条件を満たした場合の実行処理 ---

  // ケースA: 保留中の落下ダメージが存在する場合（パディング時間内の成功）
  if (hasPendingDamage && pending) {
    if (pending.timeoutId !== undefined) {
      system.clearRun(pending.timeoutId);
    }
    pendingFallDamages.delete(player.id);

    const rawReduction = calculateRawFallDamageReduction(player);
    const reducedDamage = pending.damage - rawReduction;

    // クールダウン設定
    rollStates.set(player.id, {
      triggeredAtTick: currentTick,
      activeUntilTick: -1,
      canTriggerAfterTick: currentTick + ROLL_COOLDOWN_TICKS,
    });

    // 斜め下前へのロールインパルスを付与
    applyRollImpulse(player);

    // 軽減後の残余ダメージを付与
    if (reducedDamage > 0) {
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

  return true;
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
      const rawReduction = calculateRawFallDamageReduction(player);
      const reducedDamage = originalDamage - rawReduction;

      if (reducedDamage <= 0) {
        event.cancel = true;
      } else {
        event.damage = reducedDamage;
      }

      // 斜め下前へのロールインパルスを付与
      applyRollImpulse(player);

      // ダメージ軽減適用後は発動可能時間を終了（クールダウンは維持）
      state.activeUntilTick = -1;
      return;
    }

    // パディングが無効（ゼロ以下）の場合: 即時判定のみ行い、未発動なら通常ダメージを通す
    if (ROLL_FALL_PADDING_TICKS <= 0) {
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

    // パディング期間満了時にロールが発動されなかった場合、元のダメージを付与するタイマー
    const timeoutId = system.runTimeout(() => {
      const pending = pendingFallDamages.get(player.id);
      if (!pending) return;
      pendingFallDamages.delete(player.id);

      if (!player.isValid) return;

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
