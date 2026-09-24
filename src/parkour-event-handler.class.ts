import {
  world,
  Player,
  Block,
  EquipmentSlot,
} from "@minecraft/server";

/**
 * ブロック殴打時のパルクールイベント情報
 */
export interface ParkourHitBlockEvent {
  /** パルクールトリガーを発動したプレイヤー */
  readonly player: Player;
  /** 殴打された対象ブロック（確実に存在） */
  readonly hitBlock: Block;
}

/**
 * スイング（素振り・開始）時のパルクールイベント情報
 */
export interface ParkourSwingStartEvent {
  /** パルクールトリガーを発動したプレイヤー */
  readonly player: Player;
}

export type ParkourEventCallback<T> = (event: T) => void;

/**
 * @minecraft/server の Signal スタイルに準拠したイベントシグナルクラス
 */
export class ParkourEventSignal<T> {
  private readonly listeners = new Set<ParkourEventCallback<T>>();

  /**
   * イベントを購読します。
   * @param callback イベント発生時に呼び出されるコールバック
   * @returns 購読解除用のコールバック
   */
  public subscribe(callback: ParkourEventCallback<T>): ParkourEventCallback<T> {
    this.listeners.add(callback);
    return callback;
  }

  /**
   * イベントの購読を解除します。
   * @param callback 登録解除するコールバック
   */
  public unsubscribe(callback: ParkourEventCallback<T>): void {
    this.listeners.delete(callback);
  }

  /**
   * 購読者全員にイベントを発行・通知します（内部利用）。
   */
  public dispatch(event: T): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in ParkourEventCallback:", err);
      }
    }
  }
}

/**
 * パルクール発動を許可するメインハンドアイテム一覧（素手以外）
 * ※ クリエイティブモードでブロックを破壊せずに叩くための検証用アイテム等
 */
export const ALLOWED_HELD_ITEM_IDS: ReadonlySet<string> = new Set([
  "minecraft:copper_sword",
]);

/**
 * パルクールアクションの発動を統括するイベントハンドラクラス。
 * `onHitBlock` と `onSwingStart` の2つのシグナルプロパティを持ち、
 * 手持ちアイテム判定（素手または銅の剣）を満たした時のみそれぞれの購読者へ通知します。
 */
export class ParkourEventHandler {
  /** ブロック殴打トリガー（確実に hitBlock が存在） */
  public readonly onHitBlock = new ParkourEventSignal<ParkourHitBlockEvent>();

  /** 腕スイングトリガー（空中やブロックのない場所でも発火） */
  public readonly onSwingStart = new ParkourEventSignal<ParkourSwingStartEvent>();

  private static readonly _instance = new ParkourEventHandler();

  public static getInstance(): ParkourEventHandler {
    return ParkourEventHandler._instance;
  }

  /**
   * 外部からの直接インスタンス化を禁止し、モジュールシングルトンを強制します。
   */
  private constructor() {
    this.registerNativeEvents();
  }

  /**
   * プレイヤーが素手または許可されたアイテムを持っているかを判定します。
   */
  public isValidHeldItem(player: Player): boolean {
    try {
      const equippable = player.getComponent("minecraft:equippable");
      const mainHandItem = equippable
        ? equippable.getEquipment(EquipmentSlot.Mainhand)
        : player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex);

      // 素手（何も持っていない）
      if (!mainHandItem) {
        return true;
      }

      return ALLOWED_HELD_ITEM_IDS.has(mainHandItem.typeId);
    } catch {
      return false;
    }
  }

  /**
   * @minecraft/server のネイティブイベントを登録します。
   */
  private registerNativeEvents(): void {
    // 1. entityHitBlock: ブロック殴打イベント -> onHitBlock
    try {
      if (world.afterEvents.entityHitBlock) {
        world.afterEvents.entityHitBlock.subscribe((event) => {
          if (!(event.damagingEntity instanceof Player)) return;
          const player = event.damagingEntity;
          if (!player.isValid) return;
          if (!this.isValidHeldItem(player)) return;

          this.onHitBlock.dispatch({
            player,
            hitBlock: event.hitBlock,
          });
        });
      }
    } catch (e) {
      console.warn("entityHitBlock subscription failed:", e);
    }

    // 2. playerSwingStart: スイング（空振り・開始）イベント -> onSwingStart
    try {
      if (world.afterEvents.playerSwingStart) {
        world.afterEvents.playerSwingStart.subscribe((event) => {
          const player = event.player;
          if (!player.isValid) return;
          if (!this.isValidHeldItem(player)) return;

          this.onSwingStart.dispatch({ player });
        });
      }
    } catch (e) {
      console.warn("playerSwingStart subscription failed:", e);
    }
  }
}

/**
 * パルクールイベントハンドラのモジュールシングルトンインスタンス
 */
export const parkourEventHandler = ParkourEventHandler.getInstance();
