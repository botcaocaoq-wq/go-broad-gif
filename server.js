const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Phục vụ file tĩnh ở thư mục gốc, mặc định mở sảnh index1.html
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

const SIZE = 9;
const INITIAL_TIME_MS = 5 * 60 * 1000; // 5 phút (300,000 ms) mỗi người chơi
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

function simulateMove(board, prevBoard, col, row, color) {
    if (board[col][row] !== 0) return { ok: false, msg: 'Ô này đã có quân!' };

    const nextBoard = cloneBoard(board);
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
        return { ok: false, msg: 'Nước đi tự sát không hợp lệ!' };
    }

    if (boardsEqual(nextBoard, prevBoard)) {
        return { ok: false, msg: 'Phạm luật Cướp cờ (Ko)! Hãy đánh chỗ khác trước.' };
    }

    return { ok: true, nextBoard, capturedCount };
}

// Kiểm tra xem người chơi màu `color` còn bất kỳ nước đi hợp lệ nào không
function hasAnyLegalMove(board, prevBoard, color) {
    for (let c = 0; c < SIZE; c++) {
        for (let r = 0; r < SIZE; r++) {
            if (board[c][r] === 0) {
                if (simulateMove(board, prevBoard, c, r, color).ok) {
                    return true;
                }
            }
        }
    }
    return false;
}

// Tính thời gian còn lại thực tế của cả 2 bên tại thời điểm hiện tại
function getLiveTimes(game) {
    const now = Date.now();
    const elapsed = game.isOver ? 0 : (now - game.lastTick);
    const blackTime = game.turn === 1 ? Math.max(0, game.timeLeft[1] - elapsed) : game.timeLeft[1];
    const whiteTime = game.turn === 2 ? Math.max(0, game.timeLeft[2] - elapsed) : game.timeLeft[2];
    return { blackTime, whiteTime, now };
}

function finishMatch(roomId, winner, loser, reason) {
    const game = games[roomId];
    if (!game || game.isOver) return;
    game.isOver = true;

    if (users[winner]) users[winner].score += 1;

    // Mở khóa trạng thái inGame cho 2 người chơi để quay về sảnh tìm trận mới
    for (const info of Object.values(onlinePlayers)) {
        if (info.username === winner || info.username === loser) {
            info.inGame = false;
        }
    }
    broadcastOnlineList();

    io.to(roomId).emit('matchOver', {
        winner,
        loser,
        reason,
        winnerNewScore: users[winner]?.score || 0
    });
    delete games[roomId];
}

// Vòng lặp trên Server kiểm tra hết giờ mỗi 0.5 giây -> Đảm bảo hết giờ là xử thua & hiện màn hình chiến thắng ngay lập tức
setInterval(() => {
    for (const [roomId, game] of Object.entries(games)) {
        if (game.isOver) continue;
        const { blackTime, whiteTime } = getLiveTimes(game);
        if (game.turn === 1 && blackTime <= 0) {
            finishMatch(roomId, game.white, game.black, `Quân Đen (${game.black}) đã hết 5 phút!`);
        } else if (game.turn === 2 && whiteTime <= 0) {
            finishMatch(roomId, game.black, game.white, `Quân Trắng (${game.white}) đã hết 5 phút!`);
        }
    }
}, 500);

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

function buildSyncPayload(game) {
    const { blackTime, whiteTime } = getLiveTimes(game);
    return {
        board: game.board,
        turn: game.turn,
        captures: game.captures,
        lastMove: game.lastMove,
        blackTimeMs: blackTime,
        whiteTimeMs: whiteTime,
        serverNow: Date.now()
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
            passCount: 0,
            timeLeft: { 1: INITIAL_TIME_MS, 2: INITIAL_TIME_MS },
            lastTick: Date.now(),
            isOver: false
        };

        onlinePlayers[fromSocketId].inGame = true;
        if (onlinePlayers[socket.id]) onlinePlayers[socket.id].inGame = true;
        broadcastOnlineList();

        io.to(fromSocketId).emit('gameStart', { roomId, color: 1, opponent: myUsername });
        io.to(socket.id).emit('gameStart', { roomId, color: 2, opponent: challenger.username });
    });

    // Khi người chơi F5/Reload trang web, client gọi lại joinGameRoom -> Server gửi thời gian thật đang chạy dở (không bao giờ bị reset về 5:00)
    socket.on('joinGameRoom', ({ roomId, username }) => {
        const game = games[roomId];
        if (!game) return socket.emit('gameNotFound');
        socket.join(roomId);
        socket.emit('syncBoard', buildSyncPayload(game));
    });

    socket.on('playMove', ({ roomId, col, row, username }) => {
        const game = games[roomId];
        if (!game || game.isOver) return;
        const playerColor = game.black === username ? 1 : (game.white === username ? 2 : 0);
        if (playerColor !== game.turn) return;

        // Trừ thời gian lượt vừa đi trước khi kiểm tra nước đánh
        const { blackTime, whiteTime, now } = getLiveTimes(game);
        game.timeLeft[1] = blackTime;
        game.timeLeft[2] = whiteTime;
        game.lastTick = now;

        if (game.timeLeft[playerColor] <= 0) {
            const winner = playerColor === 1 ? game.white : game.black;
            return finishMatch(roomId, winner, username, `${username} đã hết thời gian!`);
        }

        const res = simulateMove(game.board, game.prevBoard, col, row, playerColor);
        if (!res.ok) return socket.emit('invalidMove', res.msg);

        const opponent = playerColor === 1 ? 2 : 1;
        game.prevBoard = cloneBoard(game.board);
        game.board = res.nextBoard;
        game.captures[playerColor] += res.capturedCount;
        game.lastMove = { col, row };
        game.turn = opponent;
        game.passCount = 0;

        io.to(roomId).emit('syncBoard', buildSyncPayload(game));

        // Kiểm tra đối phương còn nước đi hợp lệ nào không
        if (!hasAnyLegalMove(game.board, game.prevBoard, opponent)) {
            const loserName = opponent === 1 ? game.black : game.white;
            finishMatch(roomId, username, loserName, `${loserName} không còn nước đi hợp lệ nào trên bàn cờ!`);
        }
    });

    socket.on('passTurn', ({ roomId, username }) => {
        const game = games[roomId];
        if (!game || game.isOver) return;
        const playerColor = game.black === username ? 1 : 2;
        if (playerColor !== game.turn) return;

        const { blackTime, whiteTime, now } = getLiveTimes(game);
        game.timeLeft[1] = blackTime;
        game.timeLeft[2] = whiteTime;
        game.lastTick = now;

        game.passCount++;
        if (game.passCount >= 2) {
            const scoreRes = calculateTerritoryScore(game);
            const winner = scoreRes.blackTotal > scoreRes.whiteTotal ? game.black : game.white;
            const loser = winner === game.black ? game.white : game.black;
            finishMatch(
                roomId,
                winner,
                loser,
                `Hai bên bỏ lượt — Đen: ${scoreRes.blackTotal} | Trắng: ${scoreRes.whiteTotal} (gồm 6.5 Komi)`
            );
        } else {
            const opponent = playerColor === 1 ? 2 : 1;
            game.turn = opponent;
            io.to(roomId).emit('syncBoard', buildSyncPayload(game));

            if (!hasAnyLegalMove(game.board, game.prevBoard, opponent)) {
                const loserName = opponent === 1 ? game.black : game.white;
                finishMatch(roomId, username, loserName, `${loserName} không còn nước đi hợp lệ nào!`);
            }
        }
    });

    socket.on('resignGame', ({ roomId, username }) => {
        const game = games[roomId];
        if (!game || game.isOver) return;
        const winner = game.black === username ? game.white : game.black;
        finishMatch(roomId, winner, username, `${username} đã đầu hàng`);
    });

    socket.on('disconnect', () => {
        delete onlinePlayers[socket.id];
        broadcastOnlineList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server chạy tại http://localhost:${PORT}`));
