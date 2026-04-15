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
} from '../../../shared/data-types/src/go-fish-types';

import {
  checkForBook,
  removeBook,
  getCardsOfRank,
  hasRank,
  sortCards,
} from '../../../shared/data-types/src/go-fish-types';

import * as EffectstreamBridge from '../effectstreamBridge';
import { getWalletAddress } from '../effectstreamBridge';

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

    // Create local lobby object
    const lobbyId = result.lobbyId || `lobby_${Date.now()}`;
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
      maxPlayers: 2,
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
        playerCount: parseInt(apiLobby.player_count) || 0,
        status: apiLobby.status === 'open' ? 'waiting' as const : 'in_progress' as const,
        createdAt: new Date(apiLobby.created_at).getTime(),
        isPlayerInLobby: apiLobby.is_player_in_lobby === true,
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
