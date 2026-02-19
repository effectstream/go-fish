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
  createDeck,
  shuffleDeck,
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

  // Lobby management
  async createLobby(lobbyName: string, maxPlayers: number): Promise<Lobby | null> {
    // Call blockchain middleware to create lobby
    // Pass both player name and lobby name
    const result = await EffectstreamBridge.createLobby(this.playerName, lobbyName, maxPlayers);

    if (!result.success) {
      console.error('Failed to create lobby:', result.errorMessage);
      return null;
    }

    // Create local lobby object
    const lobbyId = result.lobbyId || `lobby_${Date.now()}`;
    const lobby: Lobby = {
      id: lobbyId,
      name: lobbyName,  // Use the lobby name from user input for local state
      hostId: this.playerId,
      hostName: this.playerName,
      playerCount: 0,
      maxPlayers,
      status: 'waiting',
      createdAt: Date.now(),
    };

    this.lobbies.set(lobbyId, lobby);

    // Create game state
    const game: GoFishGameState = {
      id: lobbyId,
      status: 'waiting',
      phase: 'lobby',
      round: 0,
      players: [],
      maxPlayers,
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
      const response = await fetch(`http://localhost:9996/open_lobbies?page=0&count=50${walletParam}`);
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
        maxPlayers: apiLobby.max_players,
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

  async leaveLobby(lobbyId: string): Promise<boolean> {
    // Submit leave transaction to blockchain
    const result = await EffectstreamBridge.leaveLobby(lobbyId);

    if (!result.success) {
      console.error('Failed to leave lobby:', result.errorMessage);
      return false;
    }

    console.log('Leave lobby transaction submitted successfully');
    return true;
  }

  toggleReady(lobbyId: string): void {
    const game = this.games.get(lobbyId);
    if (!game) return;

    const player = game.players.find(p => p.id === this.playerId);
    if (player) {
      player.isReady = !player.isReady;
    }
  }

  canStartGame(lobbyId: string): boolean {
    const game = this.games.get(lobbyId);
    if (!game) return false;

    return (
      game.players.length >= 2 &&
      game.players.every(p => p.isReady || p.id === game.hostId)
    );
  }

  startGame(lobbyId: string): boolean {
    const game = this.games.get(lobbyId);
    const lobby = this.lobbies.get(lobbyId);

    if (!game || !lobby || !this.canStartGame(lobbyId)) {
      return false;
    }

    // Initialize deck and deal cards
    game.deck = shuffleDeck(createDeck());
    game.deckCount = game.deck.length;
    game.status = 'in_progress';
    game.phase = 'dealing';
    game.startedAt = Date.now();
    game.round = 1;
    game.currentTurnIndex = 0;

    lobby.status = 'in_progress';

    // Deal cards (5-7 cards per player depending on player count)
    const cardsPerPlayer = game.players.length <= 3 ? 7 : 5;

    for (const player of game.players) {
      for (let i = 0; i < cardsPerPlayer; i++) {
        const card = game.deck.pop();
        if (card) {
          player.hand.push(card);
        }
      }
      player.hand = sortCards(player.hand);
      player.cardCount = player.hand.length;

      // Check for initial books
      this.checkAndCompleteBooks(game, player);
    }

    game.deckCount = game.deck.length;
    game.phase = 'playing';

    this.addSystemMessage(lobbyId, `Game started! ${game.players[0].name}'s turn.`);

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
