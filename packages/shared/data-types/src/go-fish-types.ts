/**
 * Go Fish Game Types - Card game specific types
 */

// Card types
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';

export interface Card {
  rank: Rank;
  suit: Suit;
}

// Player hand and books
export interface PlayerHand {
  playerId: string;
  cards: Card[];
  books: Rank[]; // Completed sets of 4 cards
  cardCount: number; // For opponents, only show count
}

// Game actions
export interface AskAction {
  askerId: string;
  targetId: string;
  rank: Rank;
  timestamp: number;
}

export interface DrawAction {
  playerId: string;
  card?: Card; // undefined for other players (hidden)
  timestamp: number;
}

export interface BookAction {
  playerId: string;
  rank: Rank;
  timestamp: number;
}

// Game state
export type GamePhase = 'lobby' | 'dealing' | 'playing' | 'finished';
export type GameStatus = 'waiting' | 'in_progress' | 'finished';

export interface GoFishPlayer {
  id: string;
  name: string;
  isAlive: boolean; // Keep for compatibility, always true in Go Fish
  isReady: boolean;
  hand: Card[];
  books: Rank[];
  cardCount: number;
}

export interface GoFishGameState {
  id: string;
  status: GameStatus;
  phase: GamePhase;
  round: number;
  players: GoFishPlayer[];
  maxPlayers: number;
  hostId: string;
  currentTurnIndex: number;
  deck: Card[];
  deckCount: number;
  lastAction?: AskAction | DrawAction | BookAction;
  gameLog: string[];
  winner?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

// Lobby types (reuse from game-types.ts)
export interface Lobby {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  status: 'waiting' | 'in_progress' | 'finished';
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
  isSystem: boolean;
}

// Helper functions
export function createDeck(): Card[] {
  const ranks: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const suits: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
  const deck: Card[] = [];

  for (const rank of ranks) {
    for (const suit of suits) {
      deck.push({ rank, suit });
    }
  }

  return deck;
}

export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function checkForBook(cards: Card[], rank: Rank): boolean {
  return cards.filter(card => card.rank === rank).length === 4;
}

export function removeBook(cards: Card[], rank: Rank): Card[] {
  return cards.filter(card => card.rank !== rank);
}

export function getCardsOfRank(cards: Card[], rank: Rank): Card[] {
  return cards.filter(card => card.rank === rank);
}

export function hasRank(cards: Card[], rank: Rank): boolean {
  return cards.some(card => card.rank === rank);
}

export function getUniqueRanks(cards: Card[]): Rank[] {
  const ranks = new Set(cards.map(card => card.rank));
  return Array.from(ranks);
}

export const RANK_ORDER: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function sortCards(cards: Card[]): Card[] {
  return cards.sort((a, b) => {
    const rankDiff = RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
    if (rankDiff !== 0) return rankDiff;

    const suitOrder = ['clubs', 'diamonds', 'hearts', 'spades'];
    return suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
  });
}
