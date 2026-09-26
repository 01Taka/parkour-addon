import {
  Block,
  Player,
  type Vector3,
  world,
} from "@minecraft/server";
import {
  calculatePlayerToBlockDistance,
  type AABBDistanceResult,
} from "./positional.utils";
import {
  parkourEventHandler,
  type ParkourHitBlockEvent,
} from "./parkour-event-handler.class";

/**
 * ブロック殴打時のデバッグ情報
 */
export interface BlockHitDebugInfo {
  /** 3次元空間におけるAABB最短直線距離 */
  distance: number;
  /** XZ平面（水平方向）のAABB最短距離 */
  horizontal: number;
  /** ブロック上面を基準とした垂直距離 (point.y - maxY) */
  verticalTop: number;
  /** プレイヤーの現在のベロシティ */
  velocity: Vector3;
  /** 水平方向の速度 (sqrt(vx^2 + vz^2)) */
  horizontalSpeed: number;
  /** 3次元の合計速度 (sqrt(vx^2 + vy^2 + vz^2)) */
  totalSpeed: number;
  /** 元の距離計算結果詳細 */
  distanceResult: AABBDistanceResult;
}

/**
 * デバッグメッセージ送信オプション
 */
export interface BlockHitDebugMessageOptions {
  /** 小数点以下の表示桁数 (デフォルト: 3) */
  fractionDigits?: number;
  /** チャットメッセージとして送信するかどうか (デフォルト: true) */
  sendToChat?: boolean;
  /** アクションバーにも表示するかどうか (デフォルト: false) */
  sendToActionBar?: boolean;
}

/**
 * プレイヤーと対象ブロックの位置関係およびプレイヤーのベロシティからデバッグ情報を算出します。
 *
 * @param player 対象プレイヤー
 * @param block 殴打対象のブロックまたはその座標
 * @returns ブロック殴打デバッグ情報
 */
export function getBlockHitDebugInfo(
  player: Player,
  block: Block | Vector3,
): BlockHitDebugInfo {
  const distanceResult = calculatePlayerToBlockDistance(player, block);
  const velocity = player.getVelocity();
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
  const totalSpeed = Math.hypot(velocity.x, velocity.y, velocity.z);

  return {
    distance: distanceResult.distance,
    horizontal: distanceResult.horizontal,
    verticalTop: distanceResult.verticalTop,
    velocity,
    horizontalSpeed,
    totalSpeed,
    distanceResult,
  };
}

/**
 * デバッグ情報を見やすいフォーマットのテキストに整形します。
 *
 * @param info ブロック殴打デバッグ情報
 * @param fractionDigits 小数点以下の表示桁数 (デフォルト: 3)
 * @returns 整形済みテキスト
 */
export function formatBlockHitDebugMessage(
  info: BlockHitDebugInfo,
  fractionDigits: number = 3,
): string {
  const d = info.distance.toFixed(fractionDigits);
  const h = info.horizontal.toFixed(fractionDigits);
  const vt = info.verticalTop.toFixed(fractionDigits);

  const vx = info.velocity.x.toFixed(fractionDigits);
  const vy = info.velocity.y.toFixed(fractionDigits);
  const vz = info.velocity.z.toFixed(fractionDigits);
  const hSpd = info.horizontalSpeed.toFixed(fractionDigits);

  return (
    `§e[Hit Debug]§r §7Dist: §a${d}m§r §7| H: §b${h}m§r §7| VTop: §c${vt}m§r\n` +
    `§7Vel: §f(${vx}, ${vy}, ${vz})§r §7| HSpeed: §d${hSpd}§r`
  );
}

/**
 * ブロックを殴った際の distance, horizontal, verticalTop とプレイヤーのベロシティを取得し、
 * プレイヤーにメッセージとして送信します。
 *
 * @param player 対象プレイヤー
 * @param block 殴打されたブロック（または座標）
 * @param options 送信オプション
 * @returns 算出されたデバッグ情報
 */
export function sendBlockHitDebugMessage(
  player: Player,
  block: Block | Vector3,
  options: BlockHitDebugMessageOptions = {},
): BlockHitDebugInfo {
  const {
    fractionDigits = 3,
    sendToChat = true,
    sendToActionBar = false,
  } = options;

  const info = getBlockHitDebugInfo(player, block);
  const message = formatBlockHitDebugMessage(info, fractionDigits);

  if (sendToChat) {
    player.sendMessage(message);
  }

  if (sendToActionBar) {
    player.onScreenDisplay.setActionBar(
      `§7Dist: §a${info.distance.toFixed(2)} §7H: §b${info.horizontal.toFixed(2)} §7VT: §c${info.verticalTop.toFixed(2)} §7VelY: §f${info.velocity.y.toFixed(2)}`,
    );
  }

  return info;
}

/**
 * イベント監視オプション
 */
export interface SubscribeBlockHitDebugOptions
  extends BlockHitDebugMessageOptions {
  /**
   * 監視するイベントの種類
   * - "native": `@minecraft/server` の `entityHitBlock`（すべてのアイテム・殴打で発火）
   * - "parkour": `parkourEventHandler.onHitBlock`（素手や銅の剣などパルクール条件のみで発火）
   * デフォルト: "native"
   */
  mode?: "native" | "parkour";
}

/**
 * ブロック殴打イベントを購読し、殴打時に自動でデバッグメッセージを送信します。
 *
 * @param options 購読および送信オプション
 * @returns 購読解除用コールバック関数
 */
export function subscribeBlockHitDebugMessage(
  options: SubscribeBlockHitDebugOptions = {},
): () => void {
  const mode = options.mode ?? "native";

  if (mode === "parkour") {
    const callback = ({ player, hitBlock }: ParkourHitBlockEvent) => {
      if (!player.isValid) return;
      sendBlockHitDebugMessage(player, hitBlock, options);
    };

    parkourEventHandler.onHitBlock.subscribe(callback);
    return () => {
      parkourEventHandler.onHitBlock.unsubscribe(callback);
    };
  }

  // native モード (world.afterEvents.entityHitBlock)
  const callback = (event: { damagingEntity: any; hitBlock: Block }) => {
    if (!event.damagingEntity || !(event.damagingEntity instanceof Player)) {
      return;
    }
    const player = event.damagingEntity as Player;
    if (!player.isValid) return;

    sendBlockHitDebugMessage(player, event.hitBlock, options);
  };

  const subscription = world.afterEvents.entityHitBlock.subscribe(callback);
  return () => {
    world.afterEvents.entityHitBlock.unsubscribe(subscription);
  };
}
