/**
 * GameService - Manages game state and logic
 * This will be the bridge to on-chain state in the future
 */

import type {
  GameState,
  Lobby,
  Player,
  ChatMessage,
  Vote,
  NightAction,
  PlayerRole,
  GamePhase
} from '../../../shared/data-types/src/game-types';

export class GameService {
  private static instance: GameService;
  private lobbies: Map<string, Lobby> = new Map();
  private games: Map<string, GameState> = new Map();
  private chatMessages: Map<string, ChatMessage[]> = new Map();
  private currentPlayerId: string = '';
  private currentPlayerName: string = '';

  private constructor() {
    // Initialize with current player ID (will come from wallet later)
    this.currentPlayerId = `player_${Math.random().toString(36).substr(2, 9)}`;
  }

  static getInstance(): GameService {
    if (!GameService.instance) {
      GameService.instance = new GameService();
    }
    return GameService.instance;
  }

  // Player management
  setPlayerName(name: string) {
    this.currentPlayerName = name;
  }

  getPlayerId(): string {
    return this.currentPlayerId;
  }

  getPlayerName(): string {
    return this.currentPlayerName;
  }

  // Lobby management
  createLobby(name: string, maxPlayers: number = 8): Lobby {
    const lobbyId = `lobby_${Date.now()}`;
    const lobby: Lobby = {
      id: lobbyId,
      name,
      hostId: this.currentPlayerId,
      hostName: this.currentPlayerName,
      playerCount: 0,
      maxPlayers,
      status: 'waiting',
      createdAt: Date.now(),
    };

    this.lobbies.set(lobbyId, lobby);

    // Create initial game state
    const gameState: GameState = {
      id: lobbyId,
      status: 'waiting',
      phase: 'lobby',
      round: 0,
      players: [],
      maxPlayers,
      hostId: this.currentPlayerId,
      votes: [],
      nightActions: [],
      createdAt: Date.now(),
    };

    this.games.set(lobbyId, gameState);
    this.chatMessages.set(lobbyId, []);

    return lobby;
  }

  getLobbies(): Lobby[] {
    return Array.from(this.lobbies.values())
      .filter(lobby => lobby.status === 'waiting')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getLobby(lobbyId: string): Lobby | undefined {
    return this.lobbies.get(lobbyId);
  }

  joinLobby(lobbyId: string): boolean {
    const game = this.games.get(lobbyId);
    const lobby = this.lobbies.get(lobbyId);

    if (!game || !lobby || game.players.length >= game.maxPlayers) {
      return false;
    }

    // Check if already in game
    if (game.players.find(p => p.id === this.currentPlayerId)) {
      return true;
    }

    const player: Player = {
      id: this.currentPlayerId,
      name: this.currentPlayerName || `Player ${game.players.length + 1}`,
      isAlive: true,
      isReady: false,
    };

    game.players.push(player);
    lobby.playerCount = game.players.length;

    // Add system message
    this.addSystemMessage(lobbyId, `${player.name} joined the game`);

    return true;
  }

  leaveLobby(lobbyId: string) {
    const game = this.games.get(lobbyId);
    const lobby = this.lobbies.get(lobbyId);

    if (!game || !lobby) return;

    const playerIndex = game.players.findIndex(p => p.id === this.currentPlayerId);
    if (playerIndex === -1) return;

    const playerName = game.players[playerIndex].name;
    game.players.splice(playerIndex, 1);
    lobby.playerCount = game.players.length;

    this.addSystemMessage(lobbyId, `${playerName} left the game`);

    // If host left, assign new host or delete lobby
    if (game.hostId === this.currentPlayerId) {
      if (game.players.length > 0) {
        game.hostId = game.players[0].id;
        lobby.hostId = game.players[0].id;
        lobby.hostName = game.players[0].name;
      } else {
        this.lobbies.delete(lobbyId);
        this.games.delete(lobbyId);
        this.chatMessages.delete(lobbyId);
      }
    }
  }

  toggleReady(lobbyId: string) {
    const game = this.games.get(lobbyId);
    if (!game) return;

    const player = game.players.find(p => p.id === this.currentPlayerId);
    if (player) {
      player.isReady = !player.isReady;
    }
  }

  canStartGame(lobbyId: string): boolean {
    const game = this.games.get(lobbyId);
    if (!game) return false;

    // Need at least 4 players
    if (game.players.length < 4) return false;

    // All non-host players must be ready
    return game.players
      .filter(p => p.id !== game.hostId)
      .every(p => p.isReady);
  }

  startGame(lobbyId: string): boolean {
    const game = this.games.get(lobbyId);
    const lobby = this.lobbies.get(lobbyId);

    if (!game || !lobby || game.hostId !== this.currentPlayerId) return false;
    if (!this.canStartGame(lobbyId)) return false;

    // Assign roles
    this.assignRoles(game);

    // Update game state
    game.status = 'in_progress';
    game.phase = 'night';
    game.round = 1;
    game.startedAt = Date.now();

    lobby.status = 'in_progress';

    this.addSystemMessage(lobbyId, `Game started! Night ${game.round} begins...`);

    return true;
  }

  private assignRoles(game: GameState) {
    const playerCount = game.players.length;

    // Calculate role distribution
    // 1 werewolf per 3-4 players, 1 seer, 1 doctor, rest villagers
    const werewolfCount = Math.max(1, Math.floor(playerCount / 4));
    const seerCount = 1;
    const doctorCount = playerCount >= 6 ? 1 : 0;
    const villagerCount = playerCount - werewolfCount - seerCount - doctorCount;

    // Create role pool
    const roles: PlayerRole[] = [
      ...Array(werewolfCount).fill('werewolf'),
      ...Array(seerCount).fill('seer'),
      ...Array(doctorCount).fill('doctor'),
      ...Array(villagerCount).fill('villager'),
    ];

    // Shuffle and assign
    const shuffled = roles.sort(() => Math.random() - 0.5);
    game.players.forEach((player, index) => {
      player.role = shuffled[index];
    });
  }

  // Game phase management
  getGameState(lobbyId: string): GameState | undefined {
    return this.games.get(lobbyId);
  }

  getCurrentPlayer(lobbyId: string): Player | undefined {
    const game = this.games.get(lobbyId);
    return game?.players.find(p => p.id === this.currentPlayerId);
  }

  // Voting
  castVote(lobbyId: string, targetId: string): boolean {
    const game = this.games.get(lobbyId);
    if (!game || game.phase !== 'voting') return false;

    const voter = game.players.find(p => p.id === this.currentPlayerId);
    if (!voter || !voter.isAlive) return false;

    // Remove existing vote
    game.votes = game.votes.filter(v => v.voterId !== this.currentPlayerId);

    // Add new vote
    game.votes.push({
      voterId: this.currentPlayerId,
      targetId,
    });

    return true;
  }

  // Night actions
  performNightAction(lobbyId: string, actionType: 'kill' | 'protect' | 'investigate', targetId: string): boolean {
    const game = this.games.get(lobbyId);
    if (!game || game.phase !== 'night') return false;

    const actor = game.players.find(p => p.id === this.currentPlayerId);
    if (!actor || !actor.isAlive) return false;

    // Validate action type matches role
    if (actionType === 'kill' && actor.role !== 'werewolf') return false;
    if (actionType === 'protect' && actor.role !== 'doctor') return false;
    if (actionType === 'investigate' && actor.role !== 'seer') return false;

    // Remove existing action from this actor
    game.nightActions = game.nightActions.filter(a => a.actorId !== this.currentPlayerId);

    // Add new action
    game.nightActions.push({
      actorId: this.currentPlayerId,
      actionType,
      targetId,
    });

    return true;
  }

  // Process phase transitions (will be called by game loop)
  processNightPhase(lobbyId: string) {
    const game = this.games.get(lobbyId);
    if (!game || game.phase !== 'night') return;

    // Find kill target
    const killActions = game.nightActions.filter(a => a.actionType === 'kill');
    const protectActions = game.nightActions.filter(a => a.actionType === 'protect');

    game.eliminatedThisRound = [];

    // Process kills
    if (killActions.length > 0) {
      // Werewolves kill (simple: take first kill action)
      const killTarget = killActions[0].targetId;
      const isProtected = protectActions.some(a => a.targetId === killTarget);

      if (!isProtected) {
        const victim = game.players.find(p => p.id === killTarget);
        if (victim) {
          victim.isAlive = false;
          game.eliminatedThisRound.push(killTarget);
          this.addSystemMessage(lobbyId, `${victim.name} was eliminated during the night...`);
        }
      } else {
        this.addSystemMessage(lobbyId, 'The doctor saved someone from the werewolves!');
      }
    }

    // Clear night actions
    game.nightActions = [];

    // Check win condition
    if (this.checkWinCondition(game)) {
      return;
    }

    // Move to day phase
    game.phase = 'day';
    this.addSystemMessage(lobbyId, `Day ${game.round} begins. Discuss and vote!`);
  }

  startVoting(lobbyId: string) {
    const game = this.games.get(lobbyId);
    if (!game || game.phase !== 'day') return;

    game.phase = 'voting';
    game.votes = [];
    this.addSystemMessage(lobbyId, 'Voting phase started. Vote for who you think is a werewolf!');
  }

  processVotingPhase(lobbyId: string) {
    const game = this.games.get(lobbyId);
    if (!game || game.phase !== 'voting') return;

    // Count votes
    const voteCounts = new Map<string, number>();
    game.votes.forEach(vote => {
      voteCounts.set(vote.targetId, (voteCounts.get(vote.targetId) || 0) + 1);
    });

    // Find player with most votes
    let maxVotes = 0;
    let eliminated: string | null = null;

    voteCounts.forEach((count, playerId) => {
      if (count > maxVotes) {
        maxVotes = count;
        eliminated = playerId;
      }
    });

    if (eliminated) {
      const victim = game.players.find(p => p.id === eliminated);
      if (victim) {
        victim.isAlive = false;
        game.eliminatedThisRound = [eliminated];
        this.addSystemMessage(lobbyId, `${victim.name} was voted out! They were a ${victim.role}!`);
      }
    } else {
      this.addSystemMessage(lobbyId, 'No one was eliminated this round.');
    }

    game.votes = [];

    // Check win condition
    if (this.checkWinCondition(game)) {
      return;
    }

    // Move to next night
    game.round++;
    game.phase = 'night';
    this.addSystemMessage(lobbyId, `Night ${game.round} falls...`);
  }

  private checkWinCondition(game: GameState): boolean {
    const alivePlayers = game.players.filter(p => p.isAlive);
    const aliveWerewolves = alivePlayers.filter(p => p.role === 'werewolf');
    const aliveVillagers = alivePlayers.filter(p => p.role !== 'werewolf');

    if (aliveWerewolves.length === 0) {
      game.winner = 'villagers';
      game.status = 'finished';
      game.phase = 'finished';
      game.endedAt = Date.now();
      this.addSystemMessage(game.id, 'Villagers win! All werewolves have been eliminated!');
      return true;
    }

    if (aliveWerewolves.length >= aliveVillagers.length) {
      game.winner = 'werewolves';
      game.status = 'finished';
      game.phase = 'finished';
      game.endedAt = Date.now();
      this.addSystemMessage(game.id, 'Werewolves win! They outnumber the villagers!');
      return true;
    }

    return false;
  }

  // Chat
  sendMessage(lobbyId: string, message: string) {
    const messages = this.chatMessages.get(lobbyId) || [];

    const chatMessage: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random()}`,
      playerId: this.currentPlayerId,
      playerName: this.currentPlayerName,
      message,
      timestamp: Date.now(),
    };

    messages.push(chatMessage);
    this.chatMessages.set(lobbyId, messages);
  }

  private addSystemMessage(lobbyId: string, message: string) {
    const messages = this.chatMessages.get(lobbyId) || [];

    const chatMessage: ChatMessage = {
      id: `sys_${Date.now()}_${Math.random()}`,
      playerId: 'system',
      playerName: 'System',
      message,
      timestamp: Date.now(),
      isSystem: true,
    };

    messages.push(chatMessage);
    this.chatMessages.set(lobbyId, messages);
  }

  getMessages(lobbyId: string): ChatMessage[] {
    return this.chatMessages.get(lobbyId) || [];
  }
}
