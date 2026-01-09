// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title GoFishLobby
 * @dev Manages game lobbies and matchmaking for Go Fish
 */
contract GoFishLobby {
    struct Lobby {
        uint256 id;
        address host;
        uint8 maxPlayers;
        uint8 currentPlayers;
        address[] players;
        bool isActive;
        uint256 createdAt;
    }

    struct PlayerStats {
        uint256 gamesPlayed;
        uint256 gamesWon;
        uint256 totalBooks;
        uint256 rating;
    }

    // State variables
    uint256 private lobbyCounter;
    mapping(uint256 => Lobby) public lobbies;
    mapping(address => PlayerStats) public playerStats;
    mapping(uint256 => mapping(address => bool)) public lobbyPlayers;

    // Active lobbies list
    uint256[] public activeLobbies;
    mapping(uint256 => uint256) private lobbyIndexInActive;

    // Events
    event LobbyCreated(uint256 indexed lobbyId, address indexed host, uint8 maxPlayers);
    event PlayerJoined(uint256 indexed lobbyId, address indexed player);
    event PlayerLeft(uint256 indexed lobbyId, address indexed player);
    event LobbyClosed(uint256 indexed lobbyId);
    event GameStarted(uint256 indexed lobbyId);
    event StatsUpdated(address indexed player, uint256 gamesPlayed, uint256 gamesWon);

    /**
     * @dev Create a new lobby
     * @param maxPlayers Maximum number of players (2-6)
     */
    function createLobby(uint8 maxPlayers) external returns (uint256) {
        require(maxPlayers >= 2 && maxPlayers <= 6, "Invalid player count");

        lobbyCounter++;
        uint256 lobbyId = lobbyCounter;

        address[] memory initialPlayers = new address[](1);
        initialPlayers[0] = msg.sender;

        lobbies[lobbyId] = Lobby({
            id: lobbyId,
            host: msg.sender,
            maxPlayers: maxPlayers,
            currentPlayers: 1,
            players: initialPlayers,
            isActive: true,
            createdAt: block.timestamp
        });

        lobbyPlayers[lobbyId][msg.sender] = true;

        // Add to active lobbies
        activeLobbies.push(lobbyId);
        lobbyIndexInActive[lobbyId] = activeLobbies.length - 1;

        emit LobbyCreated(lobbyId, msg.sender, maxPlayers);
        emit PlayerJoined(lobbyId, msg.sender);

        return lobbyId;
    }

    /**
     * @dev Join an existing lobby
     * @param lobbyId ID of the lobby to join
     */
    function joinLobby(uint256 lobbyId) external {
        Lobby storage lobby = lobbies[lobbyId];

        require(lobby.isActive, "Lobby not active");
        require(lobby.currentPlayers < lobby.maxPlayers, "Lobby full");
        require(!lobbyPlayers[lobbyId][msg.sender], "Already in lobby");

        lobby.players.push(msg.sender);
        lobby.currentPlayers++;
        lobbyPlayers[lobbyId][msg.sender] = true;

        emit PlayerJoined(lobbyId, msg.sender);
    }

    /**
     * @dev Leave a lobby
     * @param lobbyId ID of the lobby to leave
     */
    function leaveLobby(uint256 lobbyId) external {
        Lobby storage lobby = lobbies[lobbyId];

        require(lobby.isActive, "Lobby not active");
        require(lobbyPlayers[lobbyId][msg.sender], "Not in lobby");

        lobbyPlayers[lobbyId][msg.sender] = false;
        lobby.currentPlayers--;

        // Remove player from array
        for (uint256 i = 0; i < lobby.players.length; i++) {
            if (lobby.players[i] == msg.sender) {
                lobby.players[i] = lobby.players[lobby.players.length - 1];
                lobby.players.pop();
                break;
            }
        }

        emit PlayerLeft(lobbyId, msg.sender);

        // Close lobby if empty or host left
        if (lobby.currentPlayers == 0 || msg.sender == lobby.host) {
            closeLobby(lobbyId);
        }
    }

    /**
     * @dev Start a game (host only)
     * @param lobbyId ID of the lobby
     */
    function startGame(uint256 lobbyId) external {
        Lobby storage lobby = lobbies[lobbyId];

        require(lobby.isActive, "Lobby not active");
        require(msg.sender == lobby.host, "Only host can start");
        require(lobby.currentPlayers >= 2, "Need at least 2 players");

        lobby.isActive = false;
        removeFromActiveLobbies(lobbyId);

        emit GameStarted(lobbyId);
    }

    /**
     * @dev Close a lobby
     * @param lobbyId ID of the lobby to close
     */
    function closeLobby(uint256 lobbyId) internal {
        Lobby storage lobby = lobbies[lobbyId];
        lobby.isActive = false;

        removeFromActiveLobbies(lobbyId);

        emit LobbyClosed(lobbyId);
    }

    /**
     * @dev Remove lobby from active list
     */
    function removeFromActiveLobbies(uint256 lobbyId) internal {
        uint256 index = lobbyIndexInActive[lobbyId];
        uint256 lastIndex = activeLobbies.length - 1;

        if (index != lastIndex) {
            uint256 lastLobbyId = activeLobbies[lastIndex];
            activeLobbies[index] = lastLobbyId;
            lobbyIndexInActive[lastLobbyId] = index;
        }

        activeLobbies.pop();
        delete lobbyIndexInActive[lobbyId];
    }

    /**
     * @dev Update player stats after game ends
     * @param player Address of the player
     * @param won Whether the player won
     * @param books Number of books collected
     */
    function updatePlayerStats(address player, bool won, uint256 books) external {
        // In production, this would be called by a trusted game contract
        // For now, we'll allow anyone to call it (for testing)

        PlayerStats storage stats = playerStats[player];
        stats.gamesPlayed++;
        stats.totalBooks += books;

        if (won) {
            stats.gamesWon++;
            stats.rating += 10; // Simple rating system
        } else {
            if (stats.rating > 5) {
                stats.rating -= 5;
            }
        }

        emit StatsUpdated(player, stats.gamesPlayed, stats.gamesWon);
    }

    // View functions

    /**
     * @dev Get lobby details
     */
    function getLobby(uint256 lobbyId) external view returns (Lobby memory) {
        return lobbies[lobbyId];
    }

    /**
     * @dev Get all active lobbies
     */
    function getActiveLobbies() external view returns (uint256[] memory) {
        return activeLobbies;
    }

    /**
     * @dev Get player stats
     */
    function getPlayerStats(address player) external view returns (PlayerStats memory) {
        return playerStats[player];
    }

    /**
     * @dev Check if player is in lobby
     */
    function isPlayerInLobby(uint256 lobbyId, address player) external view returns (bool) {
        return lobbyPlayers[lobbyId][player];
    }

    /**
     * @dev Get number of active lobbies
     */
    function getActiveLobbiesCount() external view returns (uint256) {
        return activeLobbies.length;
    }
}
