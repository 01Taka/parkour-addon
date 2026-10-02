import { world, system, Player, type Vector3 } from "@minecraft/server";

/**
 * プレイヤーの物理・遷移コンテキスト
 */
export const JumpContext = {
  GROUND: "GROUND", // 地面に足が着いており安定している
  TRANSITIONING: "TRANSITIONING", // インパルス直後（次tickで離脱予定、または離脱待ち）
  AIRBORNE: "AIRBORNE", // すでに空中（物理判定または内部状態）
} as const;

export type JumpContextType = (typeof JumpContext)[keyof typeof JumpContext];

type InternalJumpState = "READY" | "WAITING_AIRBORNE" | "AIRBORNE";

interface PlayerStateData {
  state: InternalJumpState;
  timer: number;
}

export type ImpulseVectorResolver =
  | Vector3
  | ((context: JumpContextType) => Vector3 | undefined);

export class JumpStateManager {
  private readonly timeoutTicks: number;
  private readonly playerStates: Map<string, PlayerStateData> = new Map();

  /**
   * @param timeoutTicks 天井衝突や狭所対策のセーフティタイマー（デフォルト: 10 tick）
   */
  constructor(timeoutTicks: number = 10) {
    this.timeoutTicks = timeoutTicks;
    this.initEvents();
  }

  /**
   * イベント購読および毎tick更新ループの初期化
   */
  private initEvents(): void {
    world.afterEvents.playerLeave.subscribe((event) => {
      this.playerStates.delete(event.playerId);
    });

    system.runInterval(() => {
      this.update();
    }, 1);
  }

  /**
   * プレイヤーごとの状態オブジェクトを取得（未登録なら初期化）
   */
  private getOrCreateState(playerId: string): PlayerStateData {
    let state = this.playerStates.get(playerId);
    if (!state) {
      state = { state: "READY", timer: 0 };
      this.playerStates.set(playerId, state);
    }
    return state;
  }

  /**
   * 現在のプレイヤーの状況コンテキストを取得
   */
  public getContext(player: Player): JumpContextType {
    const data = this.getOrCreateState(player.id);

    // インパルス付与後、空中に離脱するまでの待機期間（次tick以降のクライアント同期遅延含む）
    if (data.state === "WAITING_AIRBORNE") {
      return JumpContext.TRANSITIONING;
    }

    // 内部ステートがAIRBORNE、または物理判定で非接地
    if (data.state === "AIRBORNE" || !player.isOnGround) {
      return JumpContext.AIRBORNE;
    }

    return JumpContext.GROUND;
  }

  /**
   * 許可コンテキストとインパルスベクトルを受け取り、判定・付与・状態遷移を一括実行する
   * ※ Y > 0（上向き）の場合のみ離脱待機（WAITING_AIRBORNE）へ遷移する
   *
   * @param player 対象プレイヤー
   * @param allowedContexts 許可するJumpContext（単一値または配列）
   * @param impulse Vector3 または context を受け取って Vector3 を返す関数
   * @returns インパルスが付与されたか
   */
  public tryApplyImpulse(
    player: Player,
    allowedContexts: JumpContextType | readonly JumpContextType[],
    impulse: ImpulseVectorResolver,
  ): boolean {
    const context = this.getContext(player);

    // 1. コンテキスト合致判定
    const isAllowed = Array.isArray(allowedContexts)
      ? allowedContexts.includes(context)
      : allowedContexts === context;

    if (!isAllowed) {
      return false;
    }

    // 2. ベクトルの解決
    const vector = typeof impulse === "function" ? impulse(context) : impulse;
    if (!vector) {
      return false;
    }

    // 3. Y軸成分に応じた状態更新の分岐
    if (vector.y > 0) {
      // 上向きインパルス: 離脱が想定されるため排他ロックへ遷移
      return this.executeJumpAction(player, () => {
        player.applyImpulse(vector);
        return true;
      });
    } else {
      // 水平・下向きインパルス: 接地が解除されないため状態は更新せず適用のみ
      player.applyImpulse(vector);
      return true;
    }
  }

  /**
   * 汎用要求メソッド（音・エフェクト・独自フラグなど複雑な処理を挟む場合用）
   * @param player 対象プレイヤー
   * @param actionCallback 実行可否を判定し、インパルス等を実行した上で true/false を返す
   * @returns アクションが成立し、状態が更新されたか
   */
  public executeJumpAction(
    player: Player,
    actionCallback: (context: JumpContextType) => boolean,
  ): boolean {
    const data = this.getOrCreateState(player.id);
    const context = this.getContext(player);

    const didJump = actionCallback(context);

    if (didJump) {
      data.state = "WAITING_AIRBORNE";
      data.timer = this.timeoutTicks;
      return true;
    }

    return false;
  }

  /**
   * プレイヤーの状態を即座に初期状態（READY）へリセットする
   */
  public resetState(player: Player): void {
    const data = this.getOrCreateState(player.id);
    data.state = "READY";
    data.timer = 0;
  }

  /**
   * 毎tickの状態遷移処理
   */
  private update(): void {
    for (const player of world.getAllPlayers()) {
      if (!player.isValid) continue;

      const data = this.playerStates.get(player.id);
      if (!data || data.state === "READY") continue;

      // 1. タイムアウト処理（天井・狭所対策）
      if (data.timer > 0) {
        data.timer--;
        if (data.timer === 0 && data.state === "WAITING_AIRBORNE") {
          data.state = "READY";
          continue;
        }
      }

      // 2. 物理判定に基づく状態遷移
      if (data.state === "WAITING_AIRBORNE") {
        if (!player.isOnGround) {
          data.state = "AIRBORNE";
        }
      } else if (data.state === "AIRBORNE") {
        let isGrounded = player.isOnGround;
        if (isGrounded) {
          try {
            // 上昇中（vy > 0.05）のブロック角かすめによる疑似接地（Edge Glitch）を除外
            if (player.getVelocity().y <= 0.05) {
              data.state = "READY";
            }
          } catch {
            data.state = "READY";
          }
        }
      }
    }
  }
}

// シングルトンインスタンス
export const globalJumpManager = new JumpStateManager(10);
