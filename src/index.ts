import { airStrafeMain } from "./addons/air-strafe";
import { climbingMain } from "./addons/climbing";
import { pkRollMain } from "./addons/pk-roll";
import { autoJumpMain } from "./addons/auto-jump";
import { autoJumpFormGroup } from "./addons/auto-jump-setting";
import { voltMain } from "./addons/volt";
import { subscribeBlockHitDebugMessage } from "./utils/debug.utils";
import { settingsUIManager } from "./classes/settings-ui-manager.class";
import { PlayerStateManager } from "./classes/player-state-manager.class";

// メモリ解放リスナーの登録
PlayerStateManager.registerAutoCleanup();

// 各アドオン機能の初期化
// slidingMain();
airStrafeMain();
autoJumpMain();
climbingMain();
pkRollMain();
voltMain();
subscribeBlockHitDebugMessage();

// 汎用設定UIの初期化
// 1. デフォルトのアドオンON/OFFトグル設定タブを追加
settingsUIManager.registerDefaultAddonsFormGroup();

// 2. オートジャンプ既存の詳細設定タブを追加
settingsUIManager.addNewFormGroup(autoJumpFormGroup);

// 3. レバー所持＋腕振り（左クリック）によるUIオープンリスナーを登録
settingsUIManager.registerTriggerListener();
