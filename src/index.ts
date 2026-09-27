import { airStrafeMain } from "./addons/air-strafe";
// import { autoJumpMain } from "./addons/auto-jump";
import { climbingMain } from "./addons/climbing";
import { pkRollMain } from "./addons/pk-roll";
import { voltMain } from "./addons/volt";
import { stepUpMain } from "./addons/step-up";
import { subscribeBlockHitDebugMessage } from "./utils/block-hit-debug.utils";

// slidingMain();
airStrafeMain();
// autoJumpMain();
climbingMain();
pkRollMain();
voltMain();
stepUpMain();
subscribeBlockHitDebugMessage();
