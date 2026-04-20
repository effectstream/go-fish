import type { GameSceneState, StateChanges } from '../three/state/GameStateAdapter';
import type { Card } from '../../../packages/shared/data-types/src/go-fish-types';

/**
 * In-flight state for a game session.
 * - `null`     — idle (no action running)
 * - `proving`  — WASM proof generation in progress
 * - `sending`  — tx submitted to batcher, waiting for batcher ack
 * - `waiting`  — tx on-chain, waiting for opponent / chain to advance
 */
export type InFlightState = null | 'proving' | 'sending' | 'waiting';

/**
 * Explicit state machine for the setup phase.
 *
 * Transitions:
 *   idle → applying_mask → waiting_for_opponent → dealing → syncing → done
 *   Any state → failed (on error, triggering a retry)
 */
export type SetupPhase =
  | 'idle'
  | 'applying_mask'
  | 'waiting_for_opponent'
  | 'dealing'
  | 'syncing'
  | 'done'
  | 'failed';

/**
 * Snapshot of a GameSession's observable state. Cheap to read. Subscribers
 * receive this with every `stateChange` event; callers can also pull on demand
 * via `session.getSnapshot()`.
 */
export interface SessionSnapshot {
  lobbyId: string;
  playerId: 0 | 1 | 2;           // 0 until the first poll resolves
  state: GameSceneState | null;   // null before first poll
  inFlight: InFlightState;
  setupPhase: SetupPhase;
  askInProgress: boolean;
  respondInProgress: boolean;
  drawInProgress: boolean;
  initialBooksInProgress: boolean;
  /** Minimum expected hand size after an ask — used by the view to gate
   *  card interactivity until the batcher indexer catches up. */
  expectedMinHandSize: number;
}

/**
 * Payload carried on the `stateChange` event — mirrors the adapter's
 * change-handler signature so view code can port 1:1.
 */
export interface StateChangeDetail {
  current: GameSceneState;
  previous: GameSceneState | null;
  changes: StateChanges;
  snapshot: SessionSnapshot;
}

/** Payload for `inFlightChange`. */
export interface InFlightChangeDetail {
  from: InFlightState;
  to: InFlightState;
}

/** Payload for `notification` — a user-visible toast driven by session logic. */
export interface NotificationDetail {
  title: string;
  message: string;
  durationMs: number;
}

/** Payload for `waitingBanner` — a persistent banner below the turn bar.
 *  `message === null` means "hide the banner". */
export interface WaitingBannerDetail {
  message: string | null;
}

/** Payload for `ended` — game-over event with winner (or null on a tie). */
export interface EndedDetail {
  winner: 1 | 2 | null;
  snapshot: SessionSnapshot;
}

/** Payload for `sound` — named effect triggered by session-side action. */
export interface SoundDetail {
  name: 'goFish' | 'cardDeal' | 'cardFlip' | 'bookComplete' | 'cardsGained' | 'cardsTaken' | 'notification';
}

/** Payload for `drewCard` — emitted when an afterGoFish resolves and the
 *  local hand grew by exactly one card. View displays the notification +
 *  animation of the card flying from deck to hand. */
export interface DrewCardDetail {
  card: Card;
}

/** Payload for `needsAttention` — emitted when the session transitions
 *  into a state the user should react to (currently: `turn_start` becomes
 *  this player's turn). BackgroundNotifier listens for these and surfaces
 *  a toast when the session is not the foreground one. */
export interface NeedsAttentionDetail {
  reason: 'your_turn';
  snapshot: SessionSnapshot;
}

/**
 * Type map of GameSession events. Keys are event names, values are the
 * `event.detail` shape on the CustomEvent dispatched by the session.
 */
export interface GameSessionEventMap {
  stateChange: StateChangeDetail;
  inFlightChange: InFlightChangeDetail;
  notification: NotificationDetail;
  waitingBanner: WaitingBannerDetail;
  sound: SoundDetail;
  drewCard: DrewCardDetail;
  needsAttention: NeedsAttentionDetail;
  ended: EndedDetail;
  destroyed: Record<string, never>;
}
