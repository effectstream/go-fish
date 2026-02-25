import { MidnightService } from '../../services/MidnightService';
import type { Card, Rank, Suit } from '../../../../shared/data-types/src/go-fish-types';

const INDEX_TO_RANK: Rank[] = ['A', '2', '3', '4', '5', '6', '7'];
const INDEX_TO_SUIT: Suit[] = ['hearts', 'diamonds', 'clubs'];

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

      // Decrypt player hand
      let myHand: Card[] = [];
      try {
        const rawHand = await MidnightService.getPlayerHand(
          this.lobbyId,
          rawState.playerId as 1 | 2,
        );
        myHand = rawHand.map((c: { rank: number; suit: number }) => ({
          rank: INDEX_TO_RANK[c.rank] ?? 'A',
          suit: INDEX_TO_SUIT[c.suit] ?? 'hearts',
        }));
      } catch (err) {
        console.warn('[GameStateAdapter] Failed to decrypt hand:', err);
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
