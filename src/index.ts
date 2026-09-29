import { airStrafeMain } from "./addons/air-strafe";
import { climbingMain } from "./addons/climbing";
import { pkRollMain } from "./addons/pk-roll";
import { simpleAutoJumpMain } from "./addons/simple-auto-jump";
import { registerAutoJumpSettingsListener } from "./addons/simple-auto-jump-setting";
import { voltMain } from "./addons/volt";
import { subscribeBlockHitDebugMessage } from "./utils/block-hit-debug.utils";

// slidingMain();
airStrafeMain();
simpleAutoJumpMain();
registerAutoJumpSettingsListener();
climbingMain();
pkRollMain();
voltMain();
subscribeBlockHitDebugMessage();
