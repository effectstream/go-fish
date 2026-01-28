/**
 * Go Fish Game Types - Card game specific types
 *
 * SIMPLIFIED DECK FOR MIDNIGHT CONTRACT:
 * - 7 ranks: A, 2, 3, 4, 5, 6, 7
 * - 3 suits: hearts, diamonds, clubs
 * - 21 total cards (7 × 3)
 * - Book = 3 cards of same rank (7 possible books)
 * - 4 cards dealt to each player at start
 *
 * Contract uses numeric indices:
 * - Rank: 0-6 (A=0, 2=1, 3=2, 4=3, 5=4, 6=5, 7=6)
 * - Suit: 0-2 (hearts=0, diamonds=1, clubs=2)
 * - Card index = rank + (suit × 7)
 */

// Card types - simplified for Midnight contract
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7';
export type Suit = 'hearts' | 'diamonds' | 'clubs';

// Full ranks for display compatibility (used in some UI components)
export type FullRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type FullSuit = 'hearts' | 'diamonds' | 'clubs' | 'spades';

// Constants for the simplified deck
export const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7'];
export const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs'];
export const DECK_SIZE = 21;
export const CARDS_PER_PLAYER = 4;
export const CARDS_PER_BOOK = 3;
export const TOTAL_BOOKS = 7;

// Contract index mappings
export const RANK_TO_INDEX: Record<Rank, number> = {
  'A': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6
};
export const INDEX_TO_RANK: Rank[] = ['A', '2', '3', '4', '5', '6', '7'];

export const SUIT_TO_INDEX: Record<Suit, number> = {
  'hearts': 0, 'diamonds': 1, 'clubs': 2
};
export const INDEX_TO_SUIT: Suit[] = ['hearts', 'diamonds', 'clubs'];

// Convert card to contract index (0-20)
export function cardToIndex(card: Card): number {
  const rankIndex = RANK_TO_INDEX[card.rank];
  const suitIndex = SUIT_TO_INDEX[card.suit];
  return rankIndex + (suitIndex * 7);
}

// Convert contract index to card
export function indexToCard(index: number): Card {
  const rank = INDEX_TO_RANK[index % 7];
  const suit = INDEX_TO_SUIT[Math.floor(index / 7)];
  return { rank, suit };
}

export interface Card {
  rank: Rank;
  suit: Suit;
}

// Player hand and books
export interface PlayerHand {
  playerId: string;
  cards: Card[];
  books: Rank[]; // Completed sets of 3 cards (simplified deck)
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
  isPlayerInLobby?: boolean; // True if current user is already in this lobby
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
  const deck: Card[] = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
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
  return cards.filter(card => card.rank === rank).length === CARDS_PER_BOOK;
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

export const RANK_ORDER: Rank[] = RANKS;

export function sortCards(cards: Card[]): Card[] {
  return cards.sort((a, b) => {
    const rankDiff = RANK_TO_INDEX[a.rank] - RANK_TO_INDEX[b.rank];
    if (rankDiff !== 0) return rankDiff;

    return SUIT_TO_INDEX[a.suit] - SUIT_TO_INDEX[b.suit];
  });
}
