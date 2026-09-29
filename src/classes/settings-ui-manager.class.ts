import {
  Player,
  system,
  world,
  EquipmentSlot,
} from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { PlayerStateManager } from "./player-state-manager.class";
import {
  type AddonActivationMode,
  ACTIVATION_MODES,
  ACTIVATION_MODE_LABELS,
} from "./parkour-event-handler.class";

/**
 * アドオン機能の有効/無効管理用キー
 */
export const ADDON_KEYS = {
  autoJump: "addon_auto_jump_enabled",
  airStrafe: "addon_air_strafe_enabled",
  climbing: "addon_climbing_enabled",
  pkRoll: "addon_pk_roll_enabled",
  volt: "addon_volt_enabled",
  sliding: "addon_sliding_enabled",
} as const;

/**
 * 各アドオンの情報定義
 */
export interface AddonInfo {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly defaultMode: AddonActivationMode;
}

/**
 * デフォルトで用意されるアドオン機能一覧
 */
export const DEFAULT_ADDONS: readonly AddonInfo[] = [
  {
    key: ADDON_KEYS.autoJump,
    name: "オートジャンプ (Auto Jump)",
    description: "段差に近づいた際に自動でジャンプします",
    defaultMode: "always",
  },
  {
    key: ADDON_KEYS.airStrafe,
    name: "エアストレイフ (Air Strafe)",
    description: "ジャンプ中に空中での旋回・方向転換を可能にします",
    defaultMode: "always",
  },
  {
    key: ADDON_KEYS.climbing,
    name: "のぼりあがり (Climbing)",
    description: "空中でブロックの角を殴ると上によじ登ります",
    defaultMode: "always",
  },
  {
    key: ADDON_KEYS.pkRoll,
    name: "パルクールロール (Parkour Roll)",
    description: "着地直前に腕を振ることで落下ダメージを軽減・前進します",
    defaultMode: "always",
  },
  {
    key: ADDON_KEYS.volt,
    name: "ヴォルト (Volt)",
    description: "ブロックの側面を殴ることで飛び越えるように跳ねます",
    defaultMode: "always",
  },
  {
    key: ADDON_KEYS.sliding,
    name: "スライディング (Sliding)",
    description: "足元ブロックを殴ることで滑り込みます",
    defaultMode: "always",
  },
] as const;

/**
 * 設定UIのフォームグループ（タブ）定義インターフェース
 */
export interface FormGroup {
  /** 一意なグループID (タブID) */
  id: string;
  /** タブ選択画面 (ActionFormData) のボタンに表示されるラベル */
  title: string;
  /** ボタンのアイコンパス (例: "textures/items/lever.png", 省略可) */
  iconPath?: string;
  /** タブ詳細画面 (ModalFormData) のタイトル (省略時は title を使用) */
  formTitle?: string;
  /**
   * ModalFormData の項目を構築する関数
   * @param player フォームを開いたプレイヤー
   * @param form 初期化済みの ModalFormData インスタンス
   * @returns 項目追加後の ModalFormData
   */
  build: (
    player: Player,
    form: ModalFormData,
  ) => ModalFormData | Promise<ModalFormData>;
  /**
   * フォーム送信（保存）時のコールバック
   * @param player プレイヤー
   * @param formValues ModalFormData の入力値配列
   */
  onSave: (player: Player, formValues: any[]) => void | Promise<void>;
}

/**
 * 設定UIのトリガーとなるアイテムID（レバー）
 */
export const SETTINGS_TRIGGER_ITEM_ID = "minecraft:lever";

/**
 * ハイブリッド構成（ActionFormData + ModalFormData）による汎用設定UIマネージャ
 */
export class SettingsUIManager {
  private readonly formGroups: FormGroup[] = [];
  private static readonly instance = new SettingsUIManager();

  /**
   * UIを開く際の連続発火（スパム）防止用クールダウン管理
   * プレイヤーID -> 次回UIオープン可能tick
   */
  private readonly cooldownTicks = new Map<string, number>();

  /**
   * シングルトンインスタンスを取得
   */
  public static getInstance(): SettingsUIManager {
    return SettingsUIManager.instance;
  }

  /**
   * 新しいフォームグループ（タブ）を追加します。
   * 同一IDのグループが存在する場合は上書きします。
   *
   * @param group フォームグループ定義
   */
  public addNewFormGroup(group: FormGroup): this {
    const existingIndex = this.formGroups.findIndex((g) => g.id === group.id);
    if (existingIndex >= 0) {
      this.formGroups[existingIndex] = group;
    } else {
      this.formGroups.push(group);
    }
    return this;
  }

  /**
   * 登録済みのフォームグループ一覧を取得します
   */
  public getFormGroups(): readonly FormGroup[] {
    return this.formGroups;
  }

  /**
   * 指定したIDのフォームグループを削除します
   */
  public removeFormGroup(id: string): boolean {
    const index = this.formGroups.findIndex((g) => g.id === id);
    if (index >= 0) {
      this.formGroups.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * プレイヤーがメインハンドにレバーを持っているかを判定します
   */
  public isHoldingLever(player: Player): boolean {
    try {
      const equippable = player.getComponent("minecraft:equippable");
      const mainHandItem = equippable
        ? equippable.getEquipment(EquipmentSlot.Mainhand)
        : player
            .getComponent("minecraft:inventory")
            ?.container?.getItem(player.selectedSlotIndex);

      return mainHandItem?.typeId === SETTINGS_TRIGGER_ITEM_ID;
    } catch {
      return false;
    }
  }

  /**
   * 設定UIのメインメニュー（ActionFormData によるタブ選択画面）を開きます。
   *
   * @param player 対象プレイヤー
   */
  public async openMainMenu(player: Player): Promise<void> {
    if (!player.isValid) return;

    if (this.formGroups.length === 0) {
      player.sendMessage("§c[設定] 利用可能な設定項目がありません。");
      return;
    }

    const actionForm = new ActionFormData()
      .title("§l設定メニュー")
      .body("変更したい設定カテゴリ（タブ）を選択してください。");

    for (const group of this.formGroups) {
      actionForm.button(group.title, group.iconPath);
    }

    let response;
    try {
      response = await actionForm.show(player);
    } catch (err) {
      console.warn("[SettingsUIManager] Failed to show main menu:", err);
      return;
    }

    // キャンセル時（Escや×ボタンで閉じた場合）は終了
    if (response.canceled || response.selection === undefined) {
      return;
    }

    const selectedGroup = this.formGroups[response.selection];
    if (!selectedGroup) return;

    // 次のTickで選択された詳細画面を開く（UI遷移の安定化）
    system.run(() => {
      this.openSubForm(player, selectedGroup);
    });
  }

  /**
   * 指定されたカテゴリの詳細設定画面 (ModalFormData) を開きます。
   * 設定完了時やキャンセルの際には、自動で再びタブ選択画面へ戻ります。
   *
   * @param player 対象プレイヤー
   * @param group フォームグループ
   */
  public async openSubForm(player: Player, group: FormGroup): Promise<void> {
    if (!player.isValid) return;

    const baseForm = new ModalFormData()
      .title(group.formTitle ?? group.title)
      .submitButton("設定を保存");

    let builtForm: ModalFormData;
    try {
      builtForm = await group.build(player, baseForm);
    } catch (err) {
      console.error(
        `[SettingsUIManager] Error building form for '${group.id}':`,
        err,
      );
      player.sendMessage(`§c[エラー] 設定画面の生成に失敗しました: ${group.title}`);
      return;
    }

    let response;
    try {
      response = await builtForm.show(player);
    } catch (err) {
      console.warn(
        `[SettingsUIManager] Failed to show subform '${group.id}':`,
        err,
      );
      return;
    }

    // キャンセル（閉じる / 戻る）された場合：再び最初のタブ選択画面に戻る
    if (response.canceled || !response.formValues) {
      system.run(() => {
        this.openMainMenu(player);
      });
      return;
    }

    // 設定を保存
    try {
      await group.onSave(player, response.formValues);
    } catch (err) {
      console.error(
        `[SettingsUIManager] Error saving settings for '${group.id}':`,
        err,
      );
      player.sendMessage(`§c[エラー] 設定の保存に失敗しました: ${group.title}`);
    }

    // 設定完了後も、再び最初のタブ選択画面に戻る
    system.run(() => {
      this.openMainMenu(player);
    });
  }

  /**
   * 「レバーを持ちながら腕を振った時（左クリック）」のイベントリスナーを登録します。
   */
  public registerTriggerListener(): void {
    world.afterEvents.playerSwingStart.subscribe((event) => {
      const player = event.player;
      if (!player.isValid) return;

      // レバーを持っているかチェック
      if (!this.isHoldingLever(player)) return;

      const currentTick = system.currentTick;
      const nextOpenTick = this.cooldownTicks.get(player.id) ?? 0;
      if (currentTick < nextOpenTick) {
        return;
      }

      // クールダウン設定 (10 ticks = 0.5秒)
      this.cooldownTicks.set(player.id, currentTick + 10);

      system.run(() => {
        this.openMainMenu(player);
      });
    });

    // プレイヤー退出時のメモリ解放
    world.afterEvents.playerLeave.subscribe((event) => {
      this.cooldownTicks.delete(event.playerId);
    });
  }

  /**
   * デフォルトの「アドオン機能の発動条件（4段階）設定」タブを登録します。
   */
  public registerDefaultAddonsFormGroup(): this {
    this.addNewFormGroup({
      id: "addon_activation_modes",
      title: "§b機能の発動条件設定",
      formTitle: "アドオン発動条件設定",
      build: (player, form) => {
        for (const addon of DEFAULT_ADDONS) {
          const currentMode = PlayerStateManager.get<AddonActivationMode>(
            player.id,
            addon.key,
            addon.defaultMode,
          );
          const defaultIndex = Math.max(
            0,
            ACTIVATION_MODES.indexOf(currentMode),
          );
          form.dropdown(addon.name, [...ACTIVATION_MODE_LABELS], {
            defaultValueIndex: defaultIndex,
          });
        }
        return form;
      },
      onSave: (player, formValues) => {
        let changedCount = 0;
        DEFAULT_ADDONS.forEach((addon, index) => {
          const selectedIdx = formValues[index] as number;
          const newMode = ACTIVATION_MODES[selectedIdx] ?? "always";
          const oldMode = PlayerStateManager.get<AddonActivationMode>(
            player.id,
            addon.key,
            addon.defaultMode,
          );
          if (newMode !== oldMode) {
            PlayerStateManager.set(player.id, addon.key, newMode);
            changedCount++;
          }
        });

        player.sendMessage(
          `§a[設定] アドオンの発動条件設定を保存しました。(${changedCount}件の変更)`,
        );
      },
    });

    return this;
  }
}

/**
 * 設定UIマネージャのシングルトンインスタンス
 */
export const settingsUIManager = SettingsUIManager.getInstance();
