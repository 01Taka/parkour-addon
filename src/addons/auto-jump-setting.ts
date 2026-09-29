import { Player } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { PlayerStateManager } from "../classes/player-state-manager.class";
import type { FormGroup } from "../classes/settings-ui-manager.class";
import {
  AUTO_JUMP,
  type AutoJumpAngle,
  type AutoJumpHeight,
  type AutoJumpMovement,
} from "./auto-jump";

/**
 * 選択肢の一覧
 */
const HEIGHT_OPTIONS: readonly AutoJumpHeight[] = ["fit", "normal"];
const ANGLE_OPTIONS: readonly AutoJumpAngle[] = ["narrow", "wide", "all"];
const MOVEMENT_OPTIONS: readonly AutoJumpMovement[] = ["sprint", "walk", "any"];

/**
 * SettingsUIManager用のオートジャンプ設定フォームグループ
 */
export const autoJumpFormGroup: FormGroup = {
  id: "auto_jump_settings",
  title: "§6オートジャンプ詳細設定",
  formTitle: "オートジャンプ詳細設定",
  build: (player: Player, form: ModalFormData) => {
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

    return form
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
  },
  onSave: (player: Player, formValues: any[]) => {
    const [selectedHeightIdx, selectedAngleIdx, selectedMovementIdx] =
      formValues as [number, number, number];

    const newHeight = HEIGHT_OPTIONS[selectedHeightIdx] ?? AUTO_JUMP.defaults.height;
    const newAngle = ANGLE_OPTIONS[selectedAngleIdx] ?? AUTO_JUMP.defaults.angle;
    const newMovement =
      MOVEMENT_OPTIONS[selectedMovementIdx] ?? AUTO_JUMP.defaults.movement;

    // 設定を保存
    PlayerStateManager.set(player.id, AUTO_JUMP.keys.height, newHeight);
    PlayerStateManager.set(player.id, AUTO_JUMP.keys.angle, newAngle);
    PlayerStateManager.set(player.id, AUTO_JUMP.keys.movement, newMovement);

    player.sendMessage(
      `§a[AutoJump] 設定を保存しました\n§7- 高さ: §f${newHeight}\n§7- 角度: §f${newAngle}\n§7- 移動: §f${newMovement}`,
    );
  },
};

/**
 * （後方互換用）単体でオートジャンプ設定画面を開く関数
 */
export async function openAutoJumpSettings(player: Player): Promise<void> {
  const form = new ModalFormData().title(autoJumpFormGroup.formTitle ?? autoJumpFormGroup.title);
  const builtForm = await autoJumpFormGroup.build(player, form);
  const response = await builtForm.show(player);
  if (response.canceled || !response.formValues) return;
  await autoJumpFormGroup.onSave(player, response.formValues);
}
