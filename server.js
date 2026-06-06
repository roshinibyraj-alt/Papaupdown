'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const bot       = require('./bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

function emit(event, data) {
  io.emit(event, data);
}

function logEmit(line) {
  io.emit('log', line);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  bot.start(emit, logEmit);
});
