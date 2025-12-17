const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, '.')));

const rooms = {};

// Helper to generate 6 digit code
function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Create Room
    socket.on('create_room', (playerName) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            admin: socket.id,
            players: [{ id: socket.id, name: playerName }],
            slots: {
                white: null,
                black: null
            },
            gameStarted: false,
            fen: 'start' // Initial FEN
        };

        socket.join(roomCode);
        socket.emit('room_created', { roomCode, isAdmin: true });
        io.to(roomCode).emit('update_lobby', rooms[roomCode]);
        console.log(`Room ${roomCode} created by ${playerName}`);
    });

    // Join Room
    socket.on('join_room', ({ roomCode, playerName }) => {
        const room = rooms[roomCode];
        if (room) {
            // Check if already in room (simple check)
            const existingPlayer = room.players.find(p => p.id === socket.id);
            if (!existingPlayer) {
                room.players.push({ id: socket.id, name: playerName });
            }

            socket.join(roomCode);
            // If this is the creator re-joining or just joining, check admin
            const isAdmin = (socket.id === room.admin);

            socket.emit('joined_room', { roomCode, isAdmin });
            io.to(roomCode).emit('update_lobby', room);
            console.log(`${playerName} joined room ${roomCode}`);
        } else {
            socket.emit('error_message', 'Invalid Room Code');
        }
    });

    // Assign Slot (Admin Only)
    socket.on('assign_slot', ({ roomCode, playerId, slot }) => {
        const room = rooms[roomCode];
        if (room && room.admin === socket.id) {
            // Remove player from other slots if present
            if (room.slots.white && room.slots.white.id === playerId) room.slots.white = null;
            if (room.slots.black && room.slots.black.id === playerId) room.slots.black = null;

            // Find player details
            const player = room.players.find(p => p.id === playerId);
            if (player) {
                room.slots[slot] = player;
                io.to(roomCode).emit('update_lobby', room);
            }
        }
    });

    // Start Game (Admin Only)
    socket.on('start_game', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.admin === socket.id) {
            if (room.slots.white && room.slots.black) {
                room.gameStarted = true;
                io.to(roomCode).emit('game_started', {
                    whitePlayerId: room.slots.white.id,
                    blackPlayerId: room.slots.black.id
                });
                console.log(`Game started in room ${roomCode}`);
            } else {
                socket.emit('error_message', 'Both slots must be filled to start.');
            }
        }
    });

    // Resign
    socket.on('resign', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.gameStarted) {
            const resigningPlayer = room.players.find(p => p.id === socket.id);
            const winnerColor = (room.slots.white.id === socket.id) ? 'Black' : 'White';

            io.to(roomCode).emit('game_over', {
                reason: 'Resignation',
                winner: winnerColor,
                message: `${resigningPlayer.name} resigned. ${winnerColor} wins!`
            });
            room.gameStarted = false; // Or keep active for view? Better to stop.
        }
    });

    // Make Move
    socket.on('make_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if (room && room.gameStarted) {
            // In a real app, validate move with chess logic here to prevent cheating
            // For now, we relay it
            socket.to(roomCode).emit('move_made', move);
        }
    });

    // Draw Offer
    socket.on('offer_draw', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.gameStarted) {
            // Send to opponent
            socket.to(roomCode).emit('draw_offered', {
                roomCode
            });
        }
    });

    // Client claims Game Over (Checkmate/Draw detected locally)
    socket.on('claim_game_over', ({ roomCode, reason, winner, fen }) => {
        const room = rooms[roomCode];
        if (room && room.gameStarted) {
            io.to(roomCode).emit('game_over', {
                reason: reason,
                winner: winner,
                message: (winner === 'Draw') ? `Game ended in a Draw (${reason})` : `Checkmate! ${winner} Wins!`,
                fen: fen // Pass final board state
            });
            room.gameStarted = false;
        }
    });

    socket.on('accept_draw', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.gameStarted) {
            io.to(roomCode).emit('game_over', {
                reason: 'Agreement',
                winner: 'Draw',
                message: 'Game ended in a Draw (Mutual Agreement)'
            });
            room.gameStarted = false;
        }
    });

    socket.on('reject_draw', (roomCode) => {
        const room = rooms[roomCode];
        // Find opponent socket
        // But broadcast is fine if we filter on client, or better: send to opponent only.
        // For simplicity in this structure: broadcast 'draw_rejected' to room, client filters self.
        socket.to(roomCode).emit('draw_rejected');
    });

    // Chat
    socket.on('send_chat', ({ roomCode, message }) => {
        const room = rooms[roomCode];
        if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                const isAdmin = (room.admin === socket.id);
                io.to(roomCode).emit('receive_chat', {
                    name: player.name,
                    message,
                    isAdmin
                });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Handle cleanup
        for (const code in rooms) {
            const room = rooms[code];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);

                // Check if they were a player
                const isWhite = room.slots.white && room.slots.white.id === socket.id;
                const isBlack = room.slots.black && room.slots.black.id === socket.id;
                const wasPlayer = isWhite || isBlack;

                // Clear slots if they left
                if (isWhite) room.slots.white = null;
                if (isBlack) room.slots.black = null;

                // Stop game ONLY if an active player left
                if (room.gameStarted && wasPlayer) {
                    const winner = isWhite ? 'Black' : 'White';
                    io.to(code).emit('game_over', {
                        reason: 'Opponent Disconnected',
                        winner: winner,
                        message: 'Opponent Disconnected.'
                    });
                    room.gameStarted = false;
                }

                // If admin left
                if (room.admin === socket.id) {
                    if (room.players.length > 0) {
                        room.admin = room.players[0].id; // Assign new admin
                    }
                }

                io.to(code).emit('update_lobby', room);

                // Clean empty room?
                if (room.players.length === 0) {
                    delete rooms[code];
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
