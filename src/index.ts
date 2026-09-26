import { airStrafeMain } from "./addons/air-strafe";
import { climbingMain } from "./addons/climbing";
import { pkRollMain } from "./addons/pk-roll";
import { subscribeBlockHitDebugMessage } from "./utils/block-hit-debug.utils";

// slidingMain();
airStrafeMain();
climbingMain();
pkRollMain();
subscribeBlockHitDebugMessage();
