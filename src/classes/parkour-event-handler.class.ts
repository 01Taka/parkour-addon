import {
  world,
  Player,
  Block,
  EquipmentSlot,
  Direction,
  ItemStack,
} from "@minecraft/server";
import { PlayerStateManager } from "./player-state-manager.class";

/**
 * アドオンの発動条件モード (4段階)
 * 1. always: 常に発動
 * 2. bare_hand: 素手のときのみ発動
 * 3. no_tool: ツールを持っていないときのみ発動 (耐久値コンポーネント minecraft:durability を持たないアイテム、または素手)
 * 4. disabled: 無効化
 */
export type AddonActivationMode =
  | "always"
  | "bare_hand"
  | "no_tool"
  | "disabled";

export const ACTIVATION_MODES: readonly AddonActivationMode[] = [
  "always",
  "bare_hand",
  "no_tool",
  "disabled",
] as const;

export const ACTIVATION_MODE_LABELS: readonly string[] = [
  "1. 常に発動",
  "2. 素手のときのみ発動",
  "3. ツールを持っていないときのみ発動",
  "4. 無効化",
] as const;

/**
 * ブロック殴打時のパルクールイベント情報
 */
export interface ParkourHitBlockEvent {
  /** パルクールトリガーを発動したプレイヤー */
  readonly player: Player;
  /** 殴打された対象ブロック（確実に存在） */
  readonly hitBlock: Block;
  readonly hitFace: Direction;
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
 * パルクールアクションの発動および発動条件判定を統括するイベントハンドラクラス。
 */
export class ParkourEventHandler {
  /** ブロック殴打トリガー（確実に hitBlock が存在） */
  public readonly onHitBlock = new ParkourEventSignal<ParkourHitBlockEvent>();

  /** 腕スイングトリガー（空中やブロックのない場所でも発火） */
  public readonly onSwingStart =
    new ParkourEventSignal<ParkourSwingStartEvent>();

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
   * プレイヤーがメインハンドに持っているアイテムを取得します。
   */
  public getMainHandItem(player: Player): ItemStack | undefined {
    try {
      const equippable = player.getComponent("minecraft:equippable");
      return equippable
        ? equippable.getEquipment(EquipmentSlot.Mainhand)
        : player
            .getComponent("minecraft:inventory")
            ?.container?.getItem(player.selectedSlotIndex);
    } catch {
      return undefined;
    }
  }

  /**
   * 指定したアドオンが現在のプレイヤーの手持ちアイテム等の条件を満たして発動可能かを判定します。
   * PlayerStateManager から該当 addonKey の設定値（4段階）を取得して内部で評価します。
   *
   * 条件:
   * 1. "always" (常に発動): 手持ちアイテムに関係なく発動可能
   * 2. "bare_hand" (素手のときのみ発動): メインハンドにアイテムを持っていない場合のみ発動可能
   * 3. "no_tool" (ツールを持っていないときのみ発動): メインハンドのアイテムが耐久値コンポーネント (minecraft:durability) を持っていない場合（または素手）のみ発動可能
   * 4. "disabled" (無効化): 発動不可
   *
   * @param player 対象プレイヤー
   * @param addonKey PlayerStateManager に保存されているアドオンの識別キー
   * @param fallbackMode 設定が存在しない場合のデフォルト値 (デフォルト: "always")
   * @returns 発動可能な場合 true、それ以外 false
   */
  public isAddonAllowed(
    player: Player,
    addonKey: string,
    fallbackMode: AddonActivationMode = "always",
  ): boolean {
    if (!player.isValid) return false;

    // PlayerStateManager からプレイヤーの設定モードを取得
    const mode = PlayerStateManager.get<AddonActivationMode>(
      player.id,
      addonKey,
      fallbackMode,
    );

    // 4. 無効化
    if (mode === "disabled") {
      return false;
    }

    // 1. 常に発動
    if (mode === "always") {
      return true;
    }

    const mainHandItem = this.getMainHandItem(player);

    // 2. 素手のときのみ発動
    if (mode === "bare_hand") {
      return mainHandItem === undefined;
    }

    // 3. ツールを持っていないときのみ発動
    if (mode === "no_tool") {
      // 素手ならツールを持っていないので許可
      if (!mainHandItem) {
        return true;
      }
      // 耐久値コンポーネント (minecraft:durability) の有無を hasComponent() でチェック
      // 耐久値を持つアイテム（剣、ツルハシ、斧、シャベル、クワ、釣竿、ハサミ等）はツールとみなし不許可
      try {
        return !mainHandItem.hasComponent("minecraft:durability");
      } catch {
        return false;
      }
    }

    return false;
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

          this.onHitBlock.dispatch({
            player,
            hitBlock: event.hitBlock,
            hitFace: event.blockFace,
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
