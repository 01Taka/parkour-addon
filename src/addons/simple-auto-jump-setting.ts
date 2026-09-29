import { Player, system, world } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { PlayerStateManager } from "../classes/player-state-manager.class";
import {
  AUTO_JUMP,
  type AutoJumpAngle,
  type AutoJumpHeight,
  type AutoJumpMovement,
} from "./simple-auto-jump"; // ※パスは実際の環境に合わせてください

/**
 * 選択肢の一覧
 */
const HEIGHT_OPTIONS: readonly AutoJumpHeight[] = ["fit", "normal"];
const ANGLE_OPTIONS: readonly AutoJumpAngle[] = ["narrow", "wide", "all"];
const MOVEMENT_OPTIONS: readonly AutoJumpMovement[] = ["sprint", "walk", "any"];

/**
 * 設定UI用のアイテムID
 */
const SETTINGS_TRIGGER_ITEM_ID = "minecraft:feather";

/**
 * オートジャンプ設定画面を開く
 */
export async function openAutoJumpSettings(player: Player) {
  // 現在の設定値を取得
  const currentHeight = PlayerStateManager.get<AutoJumpHeight>(
    player.id,
    AUTO_JUMP.keys.height,
    AUTO_JUMP.defaults.height,
  );
  const currentAngle = PlayerStateManager.get<AutoJumpAngle>(
    player.id,
    AUTO_JUMP.keys.angle,
    AUTO_JUMP.defaults.angle,
  );
  const currentMovement = PlayerStateManager.get<AutoJumpMovement>(
    player.id,
    AUTO_JUMP.keys.movement,
    AUTO_JUMP.defaults.movement,
  );

  // ドロップダウンの初期選択インデックスを算出
  const defaultHeightIndex = Math.max(0, HEIGHT_OPTIONS.indexOf(currentHeight));
  const defaultAngleIndex = Math.max(0, ANGLE_OPTIONS.indexOf(currentAngle));
  const defaultMovementIndex = Math.max(
    0,
    MOVEMENT_OPTIONS.indexOf(currentMovement),
  );

  // フォームの構築（第3引数を ModalFormDataDropdownOptions に対応）
  const form = new ModalFormData()
    .title("オートジャンプ設定")
    .dropdown(
      "ジャンプの高さ",
      ["fit (1.05ブロック)", "normal (1.25ブロック)"],
      { defaultValueIndex: defaultHeightIndex },
    )
    .dropdown(
      "発動する角度",
      ["narrow (正面30°)", "wide (120°)", "all (360°/条件スキップ)"],
      { defaultValueIndex: defaultAngleIndex },
    )
    .dropdown(
      "発動する移動条件",
      ["sprint (ダッシュ中)", "walk (歩行/非スニーク)", "any (いつでも)"],
      { defaultValueIndex: defaultMovementIndex },
    );

  const response = await form.show(player);
  if (response.canceled || !response.formValues) return;

  const [selectedHeightIdx, selectedAngleIdx, selectedMovementIdx] =
    response.formValues as [number, number, number];

  const newHeight = HEIGHT_OPTIONS[selectedHeightIdx];
  const newAngle = ANGLE_OPTIONS[selectedAngleIdx];
  const newMovement = MOVEMENT_OPTIONS[selectedMovementIdx];

  // 設定を保存
  PlayerStateManager.set(player.id, AUTO_JUMP.keys.height, newHeight);
  PlayerStateManager.set(player.id, AUTO_JUMP.keys.angle, newAngle);
  PlayerStateManager.set(player.id, AUTO_JUMP.keys.movement, newMovement);

  player.sendMessage(
    `§a[AutoJump] 設定を保存しました\n§7- 高さ: §f${newHeight}\n§7- 角度: §f${newAngle}\n§7- 移動: §f${newMovement}`,
  );
}

/**
 * 羽を右クリックした際の設定画面呼び出しリスナーを登録
 */
export function registerAutoJumpSettingsListener() {
  world.afterEvents.itemUse.subscribe((event) => {
    if (event.itemStack.typeId === SETTINGS_TRIGGER_ITEM_ID) {
      system.run(() => {
        openAutoJumpSettings(event.source);
      });
    }
  });
}
