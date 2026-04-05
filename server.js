var express = require('express');
var path = require('path');
var app = express();
app.use(express.static(path.join(__dirname, 'public')));
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Menu en http://localhost:' + PORT); });
