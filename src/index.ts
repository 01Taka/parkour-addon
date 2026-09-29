import { airStrafeMain } from "./addons/air-strafe";
// import { autoJumpMain } from "./addons/auto-jump";
import { climbingMain } from "./addons/climbing";
import { pkRollMain } from "./addons/pk-roll";
import { simpleAutoJumpMain } from "./addons/simple-auto-jump";
import { registerAutoJumpSettingsListener } from "./addons/simple-auto-jump-setting";
import { voltMain } from "./addons/volt";
import { subscribeBlockHitDebugMessage } from "./utils/block-hit-debug.utils";

// slidingMain();
airStrafeMain();
// autoJumpMain();
simpleAutoJumpMain();
registerAutoJumpSettingsListener();
climbingMain();
pkRollMain();
voltMain();
subscribeBlockHitDebugMessage();
