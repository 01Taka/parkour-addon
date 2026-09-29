import { airStrafeMain } from "./addons/air-strafe";
import { climbingMain } from "./addons/climbing";
import { pkRollMain } from "./addons/pk-roll";
import { autoJumpMain } from "./addons/auto-jump";
import { registerAutoJumpSettingsListener } from "./addons/auto-jump-setting";
import { voltMain } from "./addons/volt";
import { subscribeBlockHitDebugMessage } from "./utils/block-hit-debug.utils";

// slidingMain();
airStrafeMain();
autoJumpMain();
registerAutoJumpSettingsListener();
climbingMain();
pkRollMain();
voltMain();
subscribeBlockHitDebugMessage();
