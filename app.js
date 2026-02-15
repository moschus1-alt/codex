const COLS = 10;
const ROWS = 20;
const BLOCK = 30;
const NEXT_BLOCK = 24;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
ctx.scale(BLOCK, BLOCK);

const nextCanvas = document.getElementById('nextBoard');
const nextCtx = nextCanvas.getContext('2d');
nextCtx.scale(NEXT_BLOCK, NEXT_BLOCK);

const scoreEl = document.getElementById('score');
const levelEl = document.getElementById('level');
const linesEl = document.getElementById('lines');
const statusEl = document.getElementById('status');
const musicBtn = document.getElementById('musicBtn');
const sfxBtn = document.getElementById('sfxBtn');

const colors = {
  I: '#4cc9f0',
  O: '#f9c74f',
  T: '#b5179e',
  S: '#80ed99',
  Z: '#ff4d6d',
  J: '#4895ef',
  L: '#f8961e'
};

const pieces = {
  I: [[1, 1, 1, 1]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1]],
  S: [[0, 1, 1], [1, 1, 0]],
  Z: [[1, 1, 0], [0, 1, 1]],
  J: [[1, 0, 0], [1, 1, 1]],
  L: [[0, 0, 1], [1, 1, 1]]
};

let board = createMatrix(COLS, ROWS);
let dropCounter = 0;
let dropInterval = 800;
let lastTime = 0;
let paused = false;
let gameOver = false;
let nextType = randomPieceType();

const state = {
  score: 0,
  level: 1,
  lines: 0
};

const player = {
  pos: { x: 0, y: 0 },
  matrix: null,
  type: null
};

const audioState = {
  musicEnabled: false,
  sfxEnabled: true
};

let audioCtx;
let masterGain;
let musicGain;
let sfxGain;
let musicTimer;
let musicStep = 0;

function createMatrix(w, h) {
  return Array.from({ length: h }, () => Array(w).fill(0));
}

function randomPieceType() {
  const types = Object.keys(pieces);
  return types[(Math.random() * types.length) | 0];
}

function cloneMatrix(matrix) {
  return matrix.map((row) => [...row]);
}

function ensureAudio() {
  if (audioCtx) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  audioCtx = new AudioContext();
  masterGain = audioCtx.createGain();
  musicGain = audioCtx.createGain();
  sfxGain = audioCtx.createGain();

  masterGain.gain.value = 0.32;
  musicGain.gain.value = 0.12;
  sfxGain.gain.value = 0.2;

  musicGain.connect(masterGain);
  sfxGain.connect(masterGain);
  masterGain.connect(audioCtx.destination);
}

function playTone(freq, duration = 0.12, type = 'square', gain = 0.18) {
  if (!audioState.sfxEnabled) return;
  ensureAudio();
  if (!audioCtx || !sfxGain) return;

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);

  g.gain.setValueAtTime(gain, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(g);
  g.connect(sfxGain);
  osc.start(now);
  osc.stop(now + duration);
}

function playSfx(name) {
  if (name === 'move') playTone(220, 0.05, 'square', 0.06);
  else if (name === 'rotate') playTone(330, 0.08, 'triangle', 0.09);
  else if (name === 'drop') playTone(140, 0.11, 'sawtooth', 0.1);
  else if (name === 'line') {
    playTone(523.25, 0.09, 'square', 0.11);
    setTimeout(() => playTone(659.26, 0.1, 'square', 0.1), 70);
  } else if (name === 'gameover') {
    playTone(220, 0.16, 'sawtooth', 0.12);
    setTimeout(() => playTone(174.61, 0.2, 'sawtooth', 0.12), 120);
  }
}

function scheduleMusic() {
  if (!audioState.musicEnabled || paused || gameOver) return;
  ensureAudio();
  if (!audioCtx || !musicGain) return;

  const melody = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63, 293.66, 329.63];
  const freq = melody[musicStep % melody.length];
  musicStep += 1;

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, now);

  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.08, now + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

  osc.connect(g);
  g.connect(musicGain);
  osc.start(now);
  osc.stop(now + 0.3);

  musicTimer = setTimeout(scheduleMusic, 300);
}

function stopMusic() {
  if (musicTimer) {
    clearTimeout(musicTimer);
    musicTimer = null;
  }
}

function toggleMusic() {
  ensureAudio();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  audioState.musicEnabled = !audioState.musicEnabled;
  musicBtn.textContent = audioState.musicEnabled ? '🎵 배경음 끄기' : '🎵 배경음 켜기';
  if (audioState.musicEnabled) {
    scheduleMusic();
    statusEl.textContent = '배경음을 켰습니다.';
  } else {
    stopMusic();
    statusEl.textContent = '배경음을 껐습니다.';
  }
}

function toggleSfx() {
  ensureAudio();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  audioState.sfxEnabled = !audioState.sfxEnabled;
  sfxBtn.textContent = audioState.sfxEnabled ? '🔊 효과음 켜짐' : '🔇 효과음 꺼짐';
  statusEl.textContent = audioState.sfxEnabled ? '효과음을 켰습니다.' : '효과음을 껐습니다.';
}

function drawCell(x, y, type, renderCtx = ctx) {
  if (!type) return;
  renderCtx.fillStyle = colors[type];
  renderCtx.fillRect(x, y, 1, 1);
  renderCtx.strokeStyle = 'rgba(255,255,255,0.2)';
  renderCtx.lineWidth = 0.04;
  renderCtx.strokeRect(x, y, 1, 1);
}

function drawMatrix(matrix, offset, type, renderCtx = ctx) {
  matrix.forEach((row, y) => {
    row.forEach((value, x) => {
      if (value) drawCell(x + offset.x, y + offset.y, type, renderCtx);
    });
  });
}

function drawNextPiece() {
  nextCtx.setTransform(NEXT_BLOCK, 0, 0, NEXT_BLOCK, 0, 0);
  nextCtx.fillStyle = '#070b17';
  nextCtx.fillRect(0, 0, 5, 5);

  const matrix = pieces[nextType];
  const offset = {
    x: Math.floor((5 - matrix[0].length) / 2),
    y: Math.floor((5 - matrix.length) / 2)
  };
  drawMatrix(matrix, offset, nextType, nextCtx);
}

function drawBoard() {
  ctx.fillStyle = '#070b17';
  ctx.fillRect(0, 0, COLS, ROWS);

  board.forEach((row, y) => {
    row.forEach((cell, x) => {
      if (cell) drawCell(x, y, cell);
    });
  });

  if (player.matrix) drawMatrix(player.matrix, player.pos, player.type);
}

function collide(arena, p) {
  const [m, o] = [p.matrix, p.pos];
  for (let y = 0; y < m.length; y += 1) {
    for (let x = 0; x < m[y].length; x += 1) {
      if (m[y][x] && (arena[y + o.y] && arena[y + o.y][x + o.x]) !== 0) {
        return true;
      }
    }
  }
  return false;
}

function merge(arena, p) {
  p.matrix.forEach((row, y) => {
    row.forEach((value, x) => {
      if (value) arena[y + p.pos.y][x + p.pos.x] = p.type;
    });
  });
}

function rotate(matrix, dir) {
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < y; x += 1) {
      [matrix[x][y], matrix[y][x]] = [matrix[y][x], matrix[x][y]];
    }
  }
  if (dir > 0) matrix.forEach((row) => row.reverse());
  else matrix.reverse();
}

function playerRotate(dir = 1) {
  if (paused || gameOver) return;
  const pos = player.pos.x;
  let offset = 1;
  rotate(player.matrix, dir);
  while (collide(board, player)) {
    player.pos.x += offset;
    offset = -(offset + (offset > 0 ? 1 : -1));
    if (offset > player.matrix[0].length) {
      rotate(player.matrix, -dir);
      player.pos.x = pos;
      return;
    }
  }
  playSfx('rotate');
  drawBoard();
}

function clearLines() {
  let rowCount = 0;
  outer: for (let y = board.length - 1; y >= 0; y -= 1) {
    for (let x = 0; x < board[y].length; x += 1) {
      if (!board[y][x]) continue outer;
    }
    const row = board.splice(y, 1)[0].fill(0);
    board.unshift(row);
    y += 1;
    rowCount += 1;
  }

  if (rowCount > 0) {
    const gain = [0, 100, 300, 500, 800][rowCount] * state.level;
    state.score += gain;
    state.lines += rowCount;
    state.level = Math.floor(state.lines / 10) + 1;
    dropInterval = Math.max(140, 800 - (state.level - 1) * 70);
    playSfx('line');
    updateHUD();
  }
}

function playerReset() {
  player.type = nextType;
  nextType = randomPieceType();
  player.matrix = cloneMatrix(pieces[player.type]);
  player.pos.y = 0;
  player.pos.x = ((COLS / 2) | 0) - ((player.matrix[0].length / 2) | 0);
  drawNextPiece();

  if (collide(board, player)) {
    gameOver = true;
    stopMusic();
    playSfx('gameover');
    statusEl.textContent = '게임 오버! 다시 시작 버튼을 눌러주세요.';
  }
}

function playerMove(dir) {
  if (paused || gameOver) return;
  player.pos.x += dir;
  if (collide(board, player)) player.pos.x -= dir;
  else playSfx('move');
  drawBoard();
}

function softDrop() {
  if (paused || gameOver) return;
  player.pos.y += 1;
  if (collide(board, player)) {
    player.pos.y -= 1;
    merge(board, player);
    playSfx('drop');
    clearLines();
    playerReset();
  }
  dropCounter = 0;
  drawBoard();
}

function hardDrop() {
  if (paused || gameOver) return;
  while (!collide(board, player)) {
    player.pos.y += 1;
  }
  player.pos.y -= 1;
  merge(board, player);
  playSfx('drop');
  clearLines();
  playerReset();
  dropCounter = 0;
  drawBoard();
}

function togglePause() {
  if (gameOver) return;
  paused = !paused;
  statusEl.textContent = paused ? '일시정지됨' : '게임 재개';

  if (paused) stopMusic();
  else if (audioState.musicEnabled) scheduleMusic();
}

function restartGame() {
  board = createMatrix(COLS, ROWS);
  state.score = 0;
  state.level = 1;
  state.lines = 0;
  dropInterval = 800;
  paused = false;
  gameOver = false;
  nextType = randomPieceType();
  updateHUD();
  statusEl.textContent = '새 게임 시작!';
  playerReset();
  drawBoard();

  if (audioState.musicEnabled) {
    stopMusic();
    scheduleMusic();
  }
}

function updateHUD() {
  scoreEl.textContent = state.score;
  levelEl.textContent = state.level;
  linesEl.textContent = state.lines;
}

function update(time = 0) {
  const delta = time - lastTime;
  lastTime = time;

  if (!paused && !gameOver) {
    dropCounter += delta;
    if (dropCounter > dropInterval) softDrop();
  }

  drawBoard();
  requestAnimationFrame(update);
}

function bindButton(id, action, repeat = false) {
  const btn = document.getElementById(id);
  if (!btn) return;
  let timer = null;

  const start = (e) => {
    e.preventDefault();
    action();
    if (repeat) timer = setInterval(action, 110);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('pointerleave', stop);
}

function bindControls() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') playerMove(-1);
    else if (event.key === 'ArrowRight') playerMove(1);
    else if (event.key === 'ArrowDown') softDrop();
    else if (event.key === 'ArrowUp') playerRotate(1);
    else if (event.code === 'Space') hardDrop();
    else if (event.key.toLowerCase() === 'p') togglePause();
    else if (event.key.toLowerCase() === 'm') toggleMusic();
  });

  bindButton('leftBtn', () => playerMove(-1), true);
  bindButton('rightBtn', () => playerMove(1), true);
  bindButton('downBtn', softDrop, true);
  bindButton('rotateBtn', () => playerRotate(1));
  bindButton('dropBtn', hardDrop);
  bindButton('pauseBtn', togglePause);
  bindButton('restartBtn', restartGame);
  bindButton('musicBtn', toggleMusic);
  bindButton('sfxBtn', toggleSfx);
}

bindControls();
restartGame();
updateHUD();
requestAnimationFrame(update);
