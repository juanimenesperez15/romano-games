var express = require('express');
var http = require('http');
var { Server } = require('socket.io');
var path = require('path');

var app = express();
var httpServer = http.createServer(app);
var io = new Server(httpServer, { pingInterval: 4000, pingTimeout: 8000, maxHttpBufferSize: 1e5 });

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Load game modules
require('./games/snake')(io.of('/snake'));
require('./games/pong')(io.of('/pong'));
require('./games/survival')(io.of('/survival'));
require('./games/escape')(io.of('/escape'));

var PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', function() {
  console.log('Las Bolas de Romano en http://localhost:' + PORT);
});
