import { MidnightService } from '../../services/MidnightService';
import { queryHandFromBatcher } from '../../services/BatcherMidnightService';
import { PlayerKeyManager } from '../../services/PlayerKeyManager';
import type { Card } from '../../../../shared/data-types/src/go-fish-types';
import { INDEX_TO_RANK, INDEX_TO_SUIT } from '../../../../shared/data-types/src/go-fish-types';

export interface GameSceneState {
  phase: string;
  playerId: number;
  currentTurn: number;
  scores: [number, number];
  handSizes: [number, number];
  deckCount: number;
  isGameOver: boolean;
  myHand: Card[];
  myBooks: string[];
  opponentName: string;
  playerName: string;
  gameLog: string[];
}

export type GameStateChangeHandler = (
  current: GameSceneState,
  previous: GameSceneState | null,
  changes: StateChanges,
) => void;

export interface StateChanges {
  phaseChanged: boolean;
  turnChanged: boolean;
  handChanged: boolean;
  scoresChanged: boolean;
  handSizesChanged: boolean;
  deckCountChanged: boolean;
  gameLogChanged: boolean;
  gameOver: boolean;
}

/**
 * Polls MidnightService for game state and dispatches changes to the Three.js scene.
 */
export class GameStateAdapter {
  private lobbyId: string;
  private walletAddress: string;
  private pollIntervalId: number | null = null;
  private pollIntervalMs = 5000;
  private previousState: GameSceneState | null = null;
  private onChange: GameStateChangeHandler;
  private polling = false;

  constructor(
    lobbyId: string,
    walletAddress: string,
    onChange: GameStateChangeHandler,
  ) {
    this.lobbyId = lobbyId;
    this.walletAddress = walletAddress;
    this.onChange = onChange;
  }

  start(): void {
    if (this.pollIntervalId !== null) return;
    // Immediate first poll
    this.poll();
    this.pollIntervalId = window.setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollIntervalId !== null) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  }

  /** Force an immediate poll (e.g., after an action). */
  async forcePoll(): Promise<void> {
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const rawState = await MidnightService.getGameState(this.lobbyId, this.walletAddress);
      if (!rawState) return;

      // Decrypt player hand using the real player secret stored in PlayerKeyManager.
      // Only query once cards have been dealt — during setup/dealing phase the ledger
      // has no cards yet, so the query would correctly return 0 cards but mislead the UI.
      let myHand: Card[] = [];
      const phase = rawState.phase ?? 'dealing';

      const handIsReady = phase !== 'dealing' && phase !== 'waiting';
      if (handIsReady) {
        const pid = rawState.playerId as 1 | 2;

        // Primary: query hand from the batcher's query server.
        // The batcher uses real on-chain indexer state, so it correctly reflects
        // card transfers from respondToAsk/goFish — unlike the backend's local sim.
        try {
          const batterHand = await queryHandFromBatcher(this.lobbyId, pid);
          if (batterHand !== null) {
            console.log(`[GameStateAdapter] batcher hand: ${batterHand.length} cards:`, JSON.stringify(batterHand));
            myHand = batterHand.map((c: { rank: number; suit: number }) => ({
              rank: INDEX_TO_RANK[c.rank] ?? 'A',
              suit: INDEX_TO_SUIT[c.suit] ?? 'hearts',
            }));
          } else {
            throw new Error("batcher returned null");
          }
        } catch (batcherErr) {
          // Fallback: use the backend's local simulation (may be stale after card transfers)
          console.warn('[GameStateAdapter] Batcher hand query failed, falling back to backend:', batcherErr instanceof Error ? batcherErr.message : String(batcherErr));
          try {
            const opponentId = (pid === 1 ? 2 : 1) as 1 | 2;
            const playerSecret = PlayerKeyManager.getPlayerSecret(this.lobbyId, pid);
            const playerSecretHex = playerSecret.toString(16).padStart(64, '0');
            const shuffleSeedBytes = PlayerKeyManager.getShuffleSeed(this.lobbyId, pid);
            const shuffleSeedHex = Array.from(shuffleSeedBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');
            let opponentSecretHex: string | undefined;
            let opponentShuffleSeedHex: string | undefined;
            if (PlayerKeyManager.hasExistingKeys(this.lobbyId, opponentId)) {
              try {
                const opponentSecret = PlayerKeyManager.getPlayerSecret(this.lobbyId, opponentId);
                opponentSecretHex = opponentSecret.toString(16).padStart(64, '0');
                const opponentSeedBytes = PlayerKeyManager.getShuffleSeed(this.lobbyId, opponentId);
                opponentShuffleSeedHex = Array.from(opponentSeedBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');
              } catch {
                // Ignore — opponent keys unavailable
              }
            }
            console.log(`[GameStateAdapter] fallback: fetching hand for player ${pid} from backend`);
            const rawHand = await MidnightService.getPlayerHandWithSecret(
              this.lobbyId,
              pid,
              playerSecretHex,
              { shuffleSeedHex, opponentSecretHex, opponentShuffleSeedHex },
            );
            console.log(`[GameStateAdapter] backend rawHand: ${rawHand.length} cards:`, JSON.stringify(rawHand));
            myHand = rawHand.map((c: { rank: number; suit: number }) => ({
              rank: INDEX_TO_RANK[c.rank] ?? 'A',
              suit: INDEX_TO_SUIT[c.suit] ?? 'hearts',
            }));
          } catch (fallbackErr) {
            console.warn('[GameStateAdapter] Backend hand fallback also failed:', fallbackErr);
          }
        }
      }

      const players = rawState.players || [];
      const myPlayer = players.find((p: any) => p.accountId === rawState.playerId);
      const opponentPlayer = players.find((p: any) => p.accountId !== rawState.playerId);

      const current: GameSceneState = {
        phase: rawState.phase ?? 'dealing',
        playerId: rawState.playerId,
        currentTurn: rawState.currentTurn,
        scores: rawState.scores as [number, number],
        handSizes: rawState.handSizes as [number, number],
        deckCount: rawState.deckCount,
        isGameOver: rawState.isGameOver,
        myHand,
        myBooks: rawState.myBooks ?? [],
        playerName: myPlayer?.name ?? `Player ${rawState.playerId}`,
        opponentName: opponentPlayer?.name ?? 'Opponent',
        gameLog: rawState.gameLog ?? [],
      };

      const changes = this.detectChanges(current, this.previousState);
      const hasAnyChange = Object.values(changes).some(Boolean);

      if (hasAnyChange || this.previousState === null) {
        this.onChange(current, this.previousState, changes);
      }

      this.previousState = current;
    } catch (err) {
      console.warn('[GameStateAdapter] Poll error:', err);
    } finally {
      this.polling = false;
    }
  }

  private detectChanges(current: GameSceneState, previous: GameSceneState | null): StateChanges {
    if (!previous) {
      return {
        phaseChanged: true,
        turnChanged: true,
        handChanged: true,
        scoresChanged: true,
        handSizesChanged: true,
        deckCountChanged: true,
        gameLogChanged: true,
        gameOver: current.isGameOver,
      };
    }

    const handChanged =
      current.myHand.length !== previous.myHand.length ||
      current.myHand.some(
        (c, i) =>
          !previous.myHand[i] ||
          c.rank !== previous.myHand[i].rank ||
          c.suit !== previous.myHand[i].suit,
      );

    return {
      phaseChanged: current.phase !== previous.phase,
      turnChanged: current.currentTurn !== previous.currentTurn,
      handChanged,
      scoresChanged:
        current.scores[0] !== previous.scores[0] ||
        current.scores[1] !== previous.scores[1],
      handSizesChanged:
        current.handSizes[0] !== previous.handSizes[0] ||
        current.handSizes[1] !== previous.handSizes[1],
      deckCountChanged: current.deckCount !== previous.deckCount,
      gameLogChanged: current.gameLog.length !== previous.gameLog.length,
      gameOver: current.isGameOver && !previous.isGameOver,
    };
  }

  get currentState(): GameSceneState | null {
    return this.previousState;
  }
}
