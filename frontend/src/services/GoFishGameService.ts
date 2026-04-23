/**
 * GoFishGameService - Manages Go Fish game state and logic
 * Connected to blockchain via Paima middleware
 */

import type {
  Rank,
  GoFishGameState,
  GoFishPlayer,
  Lobby,
  ChatMessage,
} from '../../../packages/shared/data-types/src/go-fish-types';

import {
  checkForBook,
  removeBook,
  getCardsOfRank,
  hasRank,
  sortCards,
} from '../../../packages/shared/data-types/src/go-fish-types';

import * as EffectstreamBridge from '../effectstreamBridge';
import { getWalletAddress } from '../effectstreamBridge';
import * as GoFishContractService from './GoFishContractService';
import * as PlayerKeyManager from './PlayerKeyManager';
import { setCachedGame, getCachedGame, clearCachedGame, listCachedGames } from './HandCache';
import { GameSessionManager } from '../game/GameSessionManager';

export class GoFishGameService {
  private static instance: GoFishGameService;

  private lobbies: Map<string, Lobby> = new Map();
  private games: Map<string, GoFishGameState> = new Map();
  private chats: Map<string, ChatMessage[]> = new Map();

  private playerId: string;
  private playerName: string = '';

  private constructor() {
    // Player ID will be set from wallet address after connection
    this.playerId = '';
  }

  // Initialize with wallet connection
  async initializeWithWallet(): Promise<boolean> {
    if (EffectstreamBridge.isWalletConnected()) {
      const address = EffectstreamBridge.getWalletAddress();
      if (address) {
        this.playerId = address;
        return true;
      }
    }
    return false;
  }

  static getInstance(): GoFishGameService {
    if (!GoFishGameService.instance) {
      GoFishGameService.instance = new GoFishGameService();
    }
    return GoFishGameService.instance;
  }

  // Player management
  getPlayerId(): string {
    return this.playerId;
  }

  setPlayerName(name: string): void {
    this.playerName = name;
  }

  getPlayerName(): string {
    return this.playerName;
  }

  // Lobby management — Go Fish is always a 2-player game.
  async createLobby(lobbyName: string): Promise<Lobby | null> {
    const result = await EffectstreamBridge.createLobby(this.playerName, lobbyName);

    if (!result.success) {
      console.error('Failed to create lobby:', result.errorMessage);
      return null;
    }

    // The lobby ID is assigned by the Paima state machine (not predictable).
    // effectstreamBridge.createLobby polls /user_lobbies with a snapshot-diff
    // to discover it. If it couldn't find the ID within the timeout, we can't
    // navigate to the lobby screen — return null so the UI stays on the list.
    if (!result.lobbyId) {
      console.error('Lobby created on-chain but could not discover the ID');
      return null;
    }
    const lobbyId = result.lobbyId;
    const lobby: Lobby = {
      id: lobbyId,
      name: lobbyName,
      hostId: this.playerId,
      hostName: this.playerName,
      playerCount: 0,
      status: 'waiting',
      createdAt: Date.now(),
    };

    this.lobbies.set(lobbyId, lobby);

    // Create local game state (in-memory mirror; actual game runs on Midnight).
    const game: GoFishGameState = {
      id: lobbyId,
      status: 'waiting',
      phase: 'lobby',
      round: 0,
      players: [],
      hostId: this.playerId,
      currentTurnIndex: 0,
      deck: [],
      deckCount: 0,
      gameLog: [],
      createdAt: Date.now(),
    };

    this.games.set(lobbyId, game);
    this.chats.set(lobbyId, []);

    console.log('Lobby created on-chain:', lobbyId);
    return lobby;
  }

  getLobbies(): Lobby[] {
    return Array.from(this.lobbies.values()).filter(l => l.status === 'waiting');
  }

  async fetchOpenLobbies(): Promise<Lobby[]> {
    try {
      // Include wallet address to check if player is already in each lobby
      const wallet = getWalletAddress();
      const walletParam = wallet ? `&wallet=${encodeURIComponent(wallet)}` : '';
      const { API_BASE_URL } = await import('../apiConfig');
      const response = await fetch(`${API_BASE_URL}/open_lobbies?page=0&count=50${walletParam}`);
      if (!response.ok) {
        console.error('Failed to fetch open lobbies');
        return [];
      }
      const data = await response.json();

      // Convert API response to Lobby objects
      const lobbies: Lobby[] = (data.lobbies || []).map((apiLobby: any) => ({
        id: apiLobby.lobby_id,
        name: apiLobby.lobby_name || 'Unnamed Lobby',
        hostId: apiLobby.host_account_id?.toString() || '',
        hostName: apiLobby.host_name || 'Unknown',
        guestName: apiLobby.guest_name || undefined,
        playerCount: parseInt(apiLobby.player_count) || 0,
        status: apiLobby.status === 'open' ? 'waiting' as const : 'in_progress' as const,
        createdAt: new Date(apiLobby.created_at).getTime(),
        isPlayerInLobby: apiLobby.is_player_in_lobby === true,
        hostMaskApplied: apiLobby.host_mask_applied === true,
      }));

      // Update local cache (always update to get latest player counts)
      lobbies.forEach(lobby => {
        this.lobbies.set(lobby.id, lobby);
      });

      return lobbies;
    } catch (error) {
      console.error('Error fetching lobbies:', error);
      return [];
    }
  }

  getLobby(lobbyId: string): Lobby | undefined {
    return this.lobbies.get(lobbyId);
  }

  /**
   * List all in-progress games the player can resume.
   *
   * For each EVM lobby where the player is a member and status is neither
   * 'open' nor 'finished', validates:
   *   1. Midnight contract has the game (not null, not game_over)
   *   2. Local PlayerKeyManager has this player's secrets (required to
   *      decrypt the masked hand). Keys are keyed by lobbyId+playerId.
   *   3. Positional id (1 or 2) can be resolved via the lobby's player list.
   *
   * Lobbies failing any check are dropped silently (with a log). Returns
   * the validated list — empty if nothing is resumable.
   */
  async findResumableGames(): Promise<Array<{
    lobbyId: string;
    playerId: 1 | 2;
    lobbyName: string;
    opponentName: string;
    myScore: number;
    opponentScore: number;
    isMyTurn: boolean;
    phase: number;
  }>> {
    const wallet = getWalletAddress();
    if (!wallet) return [];

    let candidates: any[];
    try {
      const result = await EffectstreamBridge.getUserLobbies(wallet, 0, 50);
      if (!result.success || !result.lobbies) return [];
      candidates = result.lobbies.filter(
        (l: any) => l.status !== 'open' && l.status !== 'finished',
      );
    } catch (err) {
      console.warn('[GoFishGameService] findResumableGames: /user_lobbies failed', err);
      return [];
    }

    const resumable: Array<{
      lobbyId: string;
      playerId: 1 | 2;
      lobbyName: string;
      opponentName: string;
      myScore: number;
      opponentScore: number;
      isMyTurn: boolean;
      phase: number;
    }> = [];
    const { API_BASE_URL } = await import('../apiConfig');

    for (const c of candidates) {
      const lobbyId = String(c.lobby_id);
      try {
        const lobbyRes = await fetch(`${API_BASE_URL}/lobby_state?lobby_id=${lobbyId}`);
        if (!lobbyRes.ok) continue;
        const lobby = await lobbyRes.json();
        const players = lobby.players ?? [];
        const myIdx = players.findIndex(
          (p: any) => p.wallet_address?.toLowerCase() === wallet.toLowerCase(),
        );
        if (myIdx < 0) continue;
        const playerId = (myIdx + 1) as 1 | 2;
        const opponent = players[myIdx === 0 ? 1 : 0];
        const opponentName = opponent?.player_name ?? 'Opponent';

        const contractState = await GoFishContractService.queryGameState(lobbyId);
        if (!contractState) {
          console.log(`[GoFishGameService] Resume skip ${lobbyId}: contract has no game`);
          continue;
        }
        if (!contractState.isGameOver && !PlayerKeyManager.hasExistingKeys(lobbyId, playerId)) {
          console.log(`[GoFishGameService] Resume skip ${lobbyId}: no local keys`);
          continue;
        }

        const opponentIdx = playerId === 1 ? 1 : 0;
        const meIdx = playerId - 1;
        resumable.push({
          lobbyId,
          playerId,
          lobbyName: c.lobby_name || 'Unnamed Lobby',
          opponentName,
          myScore: contractState.scores[meIdx] ?? 0,
          opponentScore: contractState.scores[opponentIdx] ?? 0,
          isMyTurn: contractState.currentTurn === playerId,
          phase: contractState.phase,
          winner: contractState.winner,
        });
      } catch (err) {
        console.warn(`[GoFishGameService] findResumableGames: error on ${lobbyId}`, err);
      }
    }

    return resumable;
  }

  /**
   * Call findResumableGames and write each result into HandCache. Existing
   * entries are merged — fields present in the cache (e.g., live `cards`,
   * `inFlight`) are preserved, while the chain-authoritative fields
   * (scores, phase, turn) are refreshed.
   *
   * Used by LobbyListScreen as a background backfill: runs once on first
   * show and on manual refresh, not on every render. Games with a live
   * GameSession already get their cache updated continuously by the
   * session's adapter, so this primarily fills in games played on another
   * device or tab whose session isn't alive here.
   */
  async refreshResumableCache(): Promise<void> {
    const wallet = getWalletAddress();

    // Fetch the server-authoritative list of the user's lobbies. Lobbies
    // that expired (open > 10 min) are no longer returned by /user_lobbies,
    // so any cached entry not in this set is stale and should be cleared.
    let serverLobbyIds: Set<string> | null = null;
    if (wallet) {
      try {
        const res = await EffectstreamBridge.getUserLobbies(wallet, 0, 50);
        if (res.success && res.lobbies) {
          serverLobbyIds = new Set(res.lobbies.map((l: any) => String(l.lobby_id)));
        }
      } catch { /* best-effort */ }
    }

    if (serverLobbyIds) {
      for (const [lobbyId] of listCachedGames()) {
        if (serverLobbyIds.has(lobbyId)) continue;
        if (GameSessionManager.instance.get(lobbyId)) continue;
        clearCachedGame(lobbyId);
      }
    }

    const games = await this.findResumableGames();
    for (const g of games) {
      const existing = getCachedGame(g.lobbyId);
      setCachedGame({
        lobbyId: g.lobbyId,
        playerId: g.playerId,
        lobbyName: g.lobbyName,
        opponentName: g.opponentName,
        cards: existing?.cards ?? [],
        myScore: g.myScore,
        opponentScore: g.opponentScore,
        isMyTurn: g.isMyTurn,
        phase: g.phase,
        inFlight: existing?.inFlight ?? null,
        winner: g.winner ?? existing?.winner ?? 0,
        updatedAt: Date.now(),
      });
    }
  }

  async joinLobby(lobbyId: string): Promise<boolean> {
    // Submit join transaction to blockchain
    const result = await EffectstreamBridge.joinLobby(this.playerName, lobbyId);

    if (!result.success) {
      console.error('Failed to join lobby:', result.errorMessage);
      return false;
    }

    console.log('Join lobby transaction submitted successfully');
    return true;
  }

  /**
   * Host-only: cancel an open lobby before a second player has joined.
   */
  async closeLobby(lobbyId: string): Promise<boolean> {
    const result = await EffectstreamBridge.closeLobby(lobbyId);

    if (!result.success) {
      console.error('Failed to close lobby:', result.errorMessage);
      return false;
    }

    console.log('Close lobby transaction submitted successfully');
    return true;
  }

  // Game actions
  askForCard(lobbyId: string, targetPlayerId: string, rank: Rank): boolean {
    const game = this.games.get(lobbyId);
    if (!game || game.phase !== 'playing') return false;

    const currentPlayer = game.players[game.currentTurnIndex];
    if (currentPlayer.id !== this.playerId) return false;

    // Must have the rank in your hand to ask for it
    if (!hasRank(currentPlayer.hand, rank)) {
      return false;
    }

    const targetPlayer = game.players.find(p => p.id === targetPlayerId);
    if (!targetPlayer) return false;

    const cardsGiven = getCardsOfRank(targetPlayer.hand, rank);

    if (cardsGiven.length > 0) {
      // Transfer cards
      currentPlayer.hand.push(...cardsGiven);
      targetPlayer.hand = targetPlayer.hand.filter(c => c.rank !== rank);

      currentPlayer.hand = sortCards(currentPlayer.hand);
      currentPlayer.cardCount = currentPlayer.hand.length;
      targetPlayer.cardCount = targetPlayer.hand.length;

      this.addSystemMessage(
        lobbyId,
        `${currentPlayer.name} asked ${targetPlayer.name} for ${rank}s and got ${cardsGiven.length} card(s)!`
      );

      // Check for books
      this.checkAndCompleteBooks(game, currentPlayer);

      // Player gets another turn
      game.gameLog.push(`${currentPlayer.name} got cards and goes again!`);
    } else {
      // Go Fish!
      this.addSystemMessage(lobbyId, `${currentPlayer.name} asked ${targetPlayer.name} for ${rank}s. Go Fish!`);

      const drawnCard = game.deck.pop();
      if (drawnCard) {
        currentPlayer.hand.push(drawnCard);
        currentPlayer.hand = sortCards(currentPlayer.hand);
        currentPlayer.cardCount = currentPlayer.hand.length;
        game.deckCount = game.deck.length;

        this.addSystemMessage(lobbyId, `${currentPlayer.name} drew a card.`);

        // Check for books
        this.checkAndCompleteBooks(game, currentPlayer);

        // If drew the card they asked for, they get another turn
        if (drawnCard.rank === rank) {
          this.addSystemMessage(lobbyId, `${currentPlayer.name} drew the ${rank} they asked for! Another turn!`);
        } else {
          // Next player's turn
          this.advanceTurn(game, lobbyId);
        }
      } else {
        // Deck is empty
        this.advanceTurn(game, lobbyId);
      }
    }

    // Check win condition
    this.checkWinCondition(game, lobbyId);

    return true;
  }

  private checkAndCompleteBooks(game: GoFishGameState, player: GoFishPlayer): void {
    const uniqueRanks = Array.from(new Set(player.hand.map(c => c.rank)));

    for (const rank of uniqueRanks) {
      if (checkForBook(player.hand, rank)) {
        player.hand = removeBook(player.hand, rank);
        player.books.push(rank);
        player.cardCount = player.hand.length;

        this.addSystemMessage(
          game.id,
          `📚 ${player.name} completed a book of ${rank}s!`
        );
      }
    }
  }

  private advanceTurn(game: GoFishGameState, lobbyId: string): void {
    game.currentTurnIndex = (game.currentTurnIndex + 1) % game.players.length;
    const nextPlayer = game.players[game.currentTurnIndex];

    this.addSystemMessage(lobbyId, `It's ${nextPlayer.name}'s turn.`);
  }

  private checkWinCondition(game: GoFishGameState, lobbyId: string): void {
    // Game ends when deck is empty and a player has no cards
    const playersWithNoCards = game.players.filter(p => p.hand.length === 0);

    if (game.deck.length === 0 && playersWithNoCards.length > 0) {
      // Find winner (most books)
      let maxBooks = 0;
      let winner: GoFishPlayer | undefined;

      for (const player of game.players) {
        if (player.books.length > maxBooks) {
          maxBooks = player.books.length;
          winner = player;
        }
      }

      if (winner) {
        game.status = 'finished';
        game.phase = 'finished';
        game.winner = winner.id;
        game.endedAt = Date.now();

        const lobby = this.lobbies.get(lobbyId);
        if (lobby) {
          lobby.status = 'finished';
        }

        this.addSystemMessage(lobbyId, `🎉 ${winner.name} wins with ${maxBooks} books!`);
      }
    }
  }

  // Helper methods
  getGameState(lobbyId: string): GoFishGameState | undefined {
    return this.games.get(lobbyId);
  }

  getCurrentPlayer(lobbyId: string): GoFishPlayer | undefined {
    const game = this.games.get(lobbyId);
    if (!game) return undefined;

    return game.players.find(p => p.id === this.playerId);
  }

  getCurrentTurnPlayer(lobbyId: string): GoFishPlayer | undefined {
    const game = this.games.get(lobbyId);
    if (!game) return undefined;

    return game.players[game.currentTurnIndex];
  }

  isMyTurn(lobbyId: string): boolean {
    const game = this.games.get(lobbyId);
    if (!game) return false;

    return game.players[game.currentTurnIndex]?.id === this.playerId;
  }

  // Chat
  sendMessage(lobbyId: string, message: string): void {
    const chat = this.chats.get(lobbyId);
    if (!chat) return;

    const chatMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      playerId: this.playerId,
      playerName: this.playerName,
      message,
      timestamp: Date.now(),
      isSystem: false,
    };

    chat.push(chatMessage);
  }

  getMessages(lobbyId: string): ChatMessage[] {
    return this.chats.get(lobbyId) || [];
  }

  private addSystemMessage(lobbyId: string, message: string): void {
    const chat = this.chats.get(lobbyId);
    if (!chat) return;

    const chatMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      playerId: 'system',
      playerName: 'System',
      message,
      timestamp: Date.now(),
      isSystem: true,
    };

    chat.push(chatMessage);
  }
}
