import { airStrafeMain } from "./addons/air-strafe";
import { autoJumpMain } from "./addons/auto-jump";
import { climbingMain } from "./addons/climbing";
import { pkRollMain } from "./addons/pk-roll";
import { voltMain } from "./addons/volt";
import { subscribeBlockHitDebugMessage } from "./utils/block-hit-debug.utils";

// slidingMain();
airStrafeMain();
autoJumpMain();
climbingMain();
pkRollMain();
voltMain();
subscribeBlockHitDebugMessage();
