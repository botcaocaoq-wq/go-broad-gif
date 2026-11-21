const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Đọc trực tiếp các file HTML và ảnh đang nằm ở thư mục gốc
app.use(express.static(__dirname, { index: 'index1.html' }));

const users = {};
const onlinePlayers = {};
const games = {};

function broadcastOnlineList() {
    const list = [];
    for (const [socketId, info] of Object.entries(onlinePlayers)) {
        if (!info.inGame && users[info.username]) {
            list.push({
                socketId,
                username: info.username,
                score: users[info.username].score,
                isFocused: info.isFocused
            });
        }
    }
    io.emit('onlineList', list);
}

// --- LUẬT CỜ VÂY CHUẨN 9x9 ---
const SIZE = 9;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const cloneBoard = (b) => b.map(row => [...row]);
const boardsEqual = (b1, b2) => b1 && b2 && JSON.stringify(b1) === JSON.stringify(b2);

function getGroupAndLiberties(board, startCol, startRow) {
    const color = board[startCol][startRow];
    const visited = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    const group = [];
    const liberties = new Set();
    const queue = [[startCol, startRow]];
    visited[startCol][startRow] = true;

    while (queue.length > 0) {
        const [c, r] = queue.shift();
        group.push([c, r]);
        for (const [dc, dr] of DIRS) {
            const nc = c + dc, nr = r + dr;
            if (nc >= 0 && nc < SIZE && nr >= 0 && nr < SIZE) {
                if (board[nc][nr] === 0) {
                    liberties.add(`${nc},${nr}`);
                } else if (board[nc][nr] === color && !visited[nc][nr]) {
                    visited[nc][nr] = true;
                    queue.push([nc, nr]);
                }
            }
        }
    }
    return { group, liberties: liberties.size };
}

function tryPlayMove(game, col, row, color) {
    if (game.board[col][row] !== 0) return { ok: false, msg: 'Giao điểm này đã có quân!' };

    const nextBoard = cloneBoard(game.board);
    nextBoard[col][row] = color;
    const opponent = color === 1 ? 2 : 1;
    let capturedCount = 0;

    for (const [dc, dr] of DIRS) {
        const nc = col + dc, nr = row + dr;
        if (nc >= 0 && nc < SIZE && nr >= 0 && nr < SIZE && nextBoard[nc][nr] === opponent) {
            const { group, liberties } = getGroupAndLiberties(nextBoard, nc, nr);
            if (liberties === 0) {
                capturedCount += group.length;
                for (const [gc, gr] of group) nextBoard[gc][gr] = 0;
            }
        }
    }

    const selfCheck = getGroupAndLiberties(nextBoard, col, row);
    if (capturedCount === 0 && selfCheck.liberties === 0) {
        return { ok: false, msg: 'Phạm luật: Điểm tự sát không hợp lệ!' };
    }

    if (boardsEqual(nextBoard, game.prevBoard)) {
        return { ok: false, msg: 'Phạm luật Ko: Không được lặp lại thế cờ ngay trước đó!' };
    }

    game.prevBoard = cloneBoard(game.board);
    game.board = nextBoard;
    game.captures[color] += capturedCount;
    game.lastMove = { col, row };
    game.turn = opponent;
    game.passCount = 0;
    return { ok: true };
}

function calculateTerritoryScore(game) {
    const visited = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    let blackTerritory = 0, whiteTerritory = 0;

    for (let c = 0; c < SIZE; c++) {
        for (let r = 0; r < SIZE; r++) {
            if (game.board[c][r] === 0 && !visited[c][r]) {
                const region = [];
                const borders = new Set();
                const queue = [[c, r]];
                visited[c][r] = true;

                while (queue.length > 0) {
                    const [cc, cr] = queue.shift();
                    region.push([cc, cr]);
                    for (const [dc, dr] of DIRS) {
                        const nc = cc + dc, nr = cr + dr;
                        if (nc >= 0 && nc < SIZE && nr >= 0 && nr < SIZE) {
                            if (game.board[nc][nr] === 0 && !visited[nc][nr]) {
                                visited[nc][nr] = true;
                                queue.push([nc, nr]);
                            } else if (game.board[nc][nr] !== 0) {
                                borders.add(game.board[nc][nr]);
                            }
                        }
                    }
                }
                if (borders.size === 1) {
                    if (borders.has(1)) blackTerritory += region.length;
                    if (borders.has(2)) whiteTerritory += region.length;
                }
            }
        }
    }
    return {
        blackTotal: blackTerritory + game.captures[1],
        whiteTotal: whiteTerritory + game.captures[2] + 6.5
    };
}

io.on('connection', (socket) => {
    socket.on('auth', ({ username, password, isRegister }, cb) => {
        username = (username || '').trim();
        if (!username || !password) return cb({ ok: false, msg: 'Vui lòng nhập đủ tên và mật khẩu!' });

        if (isRegister) {
            if (users[username]) return cb({ ok: false, msg: 'Tên tài khoản đã tồn tại!' });
            users[username] = { password, score: 0 };
            return cb({ ok: true, msg: 'Tạo tài khoản thành công! Điểm ban đầu: 0', score: 0 });
        } else {
            if (!users[username] || users[username].password !== password) {
                return cb({ ok: false, msg: 'Sai tên tài khoản hoặc mật khẩu!' });
            }
            return cb({ ok: true, score: users[username].score });
        }
    });

    socket.on('setTabActive', ({ username, active }) => {
        if (!username || !users[username]) return;
        onlinePlayers[socket.id] = {
            username,
            inGame: onlinePlayers[socket.id]?.inGame || false,
            isFocused: active
        };
        broadcastOnlineList();
    });

    socket.on('sendInvite', ({ targetSocketId, fromUsername }) => {
        if (onlinePlayers[targetSocketId] && !onlinePlayers[targetSocketId].inGame) {
            io.to(targetSocketId).emit('receiveInvite', {
                fromSocketId: socket.id,
                fromUsername,
                fromScore: users[fromUsername]?.score || 0
            });
        }
    });

    socket.on('acceptInvite', ({ fromSocketId, myUsername }) => {
        const challenger = onlinePlayers[fromSocketId];
        if (!challenger) return;

        const roomId = `room_${Date.now()}`;
        games[roomId] = {
            board: Array.from({ length: SIZE }, () => Array(SIZE).fill(0)),
            prevBoard: null,
            turn: 1,
            black: challenger.username,
            white: myUsername,
            captures: { 1: 0, 2: 0 },
            lastMove: null,
            passCount: 0
        };

        onlinePlayers[fromSocketId].inGame = true;
        if (onlinePlayers[socket.id]) onlinePlayers[socket.id].inGame = true;
        broadcastOnlineList();

        io.to(fromSocketId).emit('gameStart', { roomId, color: 1, opponent: myUsername });
        io.to(socket.id).emit('gameStart', { roomId, color: 2, opponent: challenger.username });
    });

    socket.on('joinGameRoom', ({ roomId, username }) => {
        const game = games[roomId];
        if (!game) return socket.emit('gameNotFound');
        socket.join(roomId);
        socket.emit('syncBoard', game);
    });

    socket.on('playMove', ({ roomId, col, row, username }) => {
        const game = games[roomId];
        if (!game) return;
        const playerColor = game.black === username ? 1 : (game.white === username ? 2 : 0);
        if (playerColor !== game.turn) return;

        const res = tryPlayMove(game, col, row, playerColor);
        if (!res.ok) return socket.emit('invalidMove', res.msg);
        io.to(roomId).emit('syncBoard', game);
    });

    socket.on('passTurn', ({ roomId, username }) => {
        const game = games[roomId];
        if (!game) return;
        const playerColor = game.black === username ? 1 : 2;
        if (playerColor !== game.turn) return;

        game.passCount++;
        if (game.passCount >= 2) {
            const scoreRes = calculateTerritoryScore(game);
            const winner = scoreRes.blackTotal > scoreRes.whiteTotal ? game.black : game.white;
            const loser = winner === game.black ? game.white : game.black;
            finishMatch(roomId, winner, loser, `Đất + Tù binh — Đen: ${scoreRes.blackTotal} | Trắng: ${scoreRes.whiteTotal} (gồm 6.5 Komi)`);
        } else {
            game.turn = playerColor === 1 ? 2 : 1;
            io.to(roomId).emit('syncBoard', game);
        }
    });

    socket.on('resignGame', ({ roomId, username }) => {
        const game = games[roomId];
        if (!game) return;
        const winner = game.black === username ? game.white : game.black;
        finishMatch(roomId, winner, username, `${username} đã đầu hàng`);
    });

    function finishMatch(roomId, winner, loser, reason) {
        if (users[winner]) users[winner].score += 1;
        io.to(roomId).emit('matchOver', {
            winner,
            loser,
            reason,
            winnerNewScore: users[winner]?.score || 0
        });
        delete games[roomId];
    }

    socket.on('disconnect', () => {
        delete onlinePlayers[socket.id];
        broadcastOnlineList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server chạy tại http://localhost:${PORT}`));
