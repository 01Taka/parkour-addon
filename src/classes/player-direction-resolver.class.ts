import { world, system, Player, type Vector3 } from "@minecraft/server";

export interface DirectionData {
  vector: Vector3; // 元のVector3
  normalizedXZ: Vector3; // XZで正規化されたVector3 (yは0、長さは1 ※ゼロ時は0)
  xzHypot: number; // 水平方向(XZ平面)の大きさ
}

function calcData(vector: Vector3): DirectionData {
  const xzHypot = Math.hypot(vector.x, vector.z);
  return {
    vector,
    normalizedXZ:
      xzHypot > 1e-9
        ? { x: vector.x / xzHypot, y: 0, z: vector.z / xzHypot }
        : { x: 0, y: 0, z: 0 },
    xzHypot,
  };
}

export class PlayerDirectionResolver {
  // --------------------------------------------------
  // クラス内部でのプレイヤー管理 (static)
  // --------------------------------------------------
  private static instances = new Map<string, PlayerDirectionResolver>();

  static {
    // プレイヤー退出時に自動でMapから削除（メモリリーク防止）
    world.afterEvents.playerLeave.subscribe((event) => {
      PlayerDirectionResolver.instances.delete(event.playerId);
    });
  }

  /**
   * プレイヤーに対応するリゾルバーを取得（または生成）する
   */
  public static get(player: Player): PlayerDirectionResolver {
    let resolver = this.instances.get(player.id);
    if (!resolver) {
      resolver = new PlayerDirectionResolver(player);
      this.instances.set(player.id, resolver);
    } else {
      resolver.player = player;
    }
    return resolver;
  }

  // --------------------------------------------------
  // インスタンスメンバー
  // --------------------------------------------------
  private player: Player;
  private lastTick: number = -1;

  private _movement: DirectionData | null = null;
  private _input: DirectionData | null = null;
  private _worldInput: DirectionData | null = null;
  private _view: DirectionData | null = null;

  private constructor(player: Player) {
    this.player = player;
  }

  /**
   * Tickが変わっていれば自動でキャッシュを破棄する
   */
  private checkTick(): void {
    const currentTick = system.currentTick;
    if (this.lastTick !== currentTick) {
      this.lastTick = currentTick;
      this._movement = null;
      this._input = null;
      this._worldInput = null;
      this._view = null;
    }
  }

  /** 移動方向（物理的な速度 Velocity） */
  public get movement(): DirectionData {
    this.checkTick();
    if (!this._movement) {
      this._movement = calcData(this.player.getVelocity());
    }
    return this._movement;
  }

  /** ローカル入力方向（一般的な3Dローカル座標系: x=右(+)/左(-), z=前(+)/後(-)） */
  public get input(): DirectionData {
    this.checkTick();
    if (!this._input) {
      const raw = this.player.inputInfo.getMovementVector();
      // Minecraft の raw.x は左が正(+)のため、反転して右を正(+)にする
      this._input = calcData({ x: -raw.x, y: 0, z: raw.y });
    }
    return this._input;
  }

  /**
   * ワールド基準の入力方向（プレイヤーの向きを考慮した実際のワールド進行方向）
   */
  public get worldInput(): DirectionData {
    this.checkTick();
    if (!this._worldInput) {
      const raw = this.player.inputInfo.getMovementVector();

      // 入力がない場合はゼロベクトル
      if (Math.abs(raw.x) < 1e-5 && Math.abs(raw.y) < 1e-5) {
        this._worldInput = calcData({ x: 0, y: 0, z: 0 });
      } else {
        // プレイヤーの水平角度 (Yaw) からワールドの前方・右方単位ベクトルを算出
        // ※真上・真下を向いていても水平角度は正確に取得できます
        const yawRad = (this.player.getRotation().y * Math.PI) / 180;
        const forwardX = -Math.sin(yawRad);
        const forwardZ = Math.cos(yawRad);

        // 右方向は前方から時計回りに90度回転した向き
        const rightX = -forwardZ;
        const rightZ = forwardX;

        // Minecraft の raw.x は「左が正(+)、右が負(-)」のため、反転して「右を正(+)」にする
        const strafeRight = -raw.x;

        // 前後入力(raw.y) と 左右入力(strafeRight) をワールド空間で合成
        const worldX = forwardX * raw.y + rightX * strafeRight;
        const worldZ = forwardZ * raw.y + rightZ * strafeRight;

        this._worldInput = calcData({ x: worldX, y: 0, z: worldZ });
      }
    }
    return this._worldInput;
  }

  /** 視線方向（向いている向きの単位ベクトル） */
  public get view(): DirectionData {
    this.checkTick();
    if (!this._view) {
      this._view = calcData(this.player.getViewDirection());
    }
    return this._view;
  }
}
