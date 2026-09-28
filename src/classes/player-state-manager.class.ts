import { world } from "@minecraft/server";

export class PlayerStateManager {
  // playerId -> (key -> value)
  private static state: Map<string, Map<string, any>> = new Map();

  /**
   * プレイヤーの状態を設定・保存します
   * @param playerId プレイヤーのID (player.id)
   * @param key 管理したいキー名
   * @param value 保存する値
   */
  public static set<T>(playerId: string, key: string, value: T): void {
    let playerMap = this.state.get(playerId);
    if (!playerMap) {
      playerMap = new Map<string, any>();
      this.state.set(playerId, playerMap);
    }
    playerMap.set(key, value);
  }

  /**
   * プレイヤーの状態を取得します
   * @param playerId プレイヤーのID (player.id)
   * @param key 取得したいキー名
   * @param fallback 値が存在しなかった場合のデフォルト値
   */
  public static get<T>(
    playerId: string,
    key: string,
    fallback?: T,
  ): T | undefined {
    const playerMap = this.state.get(playerId);
    if (!playerMap || !playerMap.has(key)) {
      return fallback;
    }
    return playerMap.get(key) as T;
  }

  /**
   * 指定したキーが存在するか確認します
   */
  public static has(playerId: string, key: string): boolean {
    return this.state.get(playerId)?.has(key) ?? false;
  }

  /**
   * 特定のキーのデータを削除します
   */
  public static delete(playerId: string, key: string): boolean {
    const playerMap = this.state.get(playerId);
    if (!playerMap) return false;
    return playerMap.delete(key);
  }

  /**
   * プレイヤーのすべての状態を削除します（メモリ解放用）
   */
  public static clearPlayer(playerId: string): boolean {
    return this.state.delete(playerId);
  }

  /**
   * プレイヤー退出時に自動でメモリを解放するリスナーを登録します
   */
  public static registerAutoCleanup(): void {
    world.afterEvents.playerLeave.subscribe((event) => {
      this.clearPlayer(event.playerId);
    });
  }
}
