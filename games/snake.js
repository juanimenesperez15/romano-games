module.exports = function(io) {

var WORLD_W = 2000, WORLD_H = 2000, GAME_TPS = 60, NET_TPS = 30;
var FOOD_COUNT = 400, POWERUP_COUNT = 8, SPEED = 3.2, BOOST_SPEED = 5.5;
var SEGMENT_DIST = 12, START_LENGTH = 15, FOOD_GROW = 1, SEG_DIST_SQ = SEGMENT_DIST * SEGMENT_DIST;

var players = {}, food = [], powerups = [], allTimeScores = [];

var POWERUP_TYPES = [
  { type: 'speed',  color: '#FBBF24', icon: '\u26A1',           duration: 5000 },
  { type: 'shield', color: '#3B82F6', icon: '\uD83D\uDEE1\uFE0F', duration: 4000 },
  { type: 'magnet', color: '#A78BFA', icon: '\uD83E\uDDF2',       duration: 6000 },
  { type: 'x2',     color: '#22C55E', icon: '\u2716\uFE0F2',      duration: 8000 },
  { type: 'shrink', color: '#EF4444', icon: '\uD83D\uDC80',       duration: 0 },
  { type: 'ghost',  color: '#94A3B8', icon: '\uD83D\uDC7B',       duration: 4000 },
];

function spawnFood() { return { x: 20+Math.random()*(WORLD_W-40), y: 20+Math.random()*(WORLD_H-40), r: 5+Math.random()*4, color: 'hsl('+Math.floor(Math.random()*360)+', 80%, 60%)' }; }
function spawnPowerup() { var t=POWERUP_TYPES[Math.floor(Math.random()*POWERUP_TYPES.length)]; return { id:Date.now()+Math.random(), x:100+Math.random()*(WORLD_W-200), y:100+Math.random()*(WORLD_H-200), r:12, type:t.type, color:t.color, icon:t.icon }; }

for(var i=0;i<FOOD_COUNT;i++) food.push(spawnFood());
for(var j=0;j<POWERUP_COUNT;j++) powerups.push(spawnPowerup());

function createPlayer(id,name,skin) {
  var x=200+Math.random()*(WORLD_W-400), y=200+Math.random()*(WORLD_H-400), angle=Math.random()*Math.PI*2, segments=[];
  for(var i=0;i<START_LENGTH;i++) segments.push({x:x-Math.cos(angle)*i*SEGMENT_DIST,y:y-Math.sin(angle)*i*SEGMENT_DIST});
  return {id:id,name:name||'Gusano',skin:skin||'classic',segments:segments,angle:angle,targetAngle:angle,boosting:false,score:0,alive:true,effects:{}};
}
function dropFood(segs) { var c=Math.min(segs.length,30); for(var i=0;i<c;i++){var s=segs[Math.floor(Math.random()*segs.length)]; food.push({x:Math.max(5,Math.min(WORLD_W-5,s.x+(Math.random()-.5)*30)),y:Math.max(5,Math.min(WORLD_H-5,s.y+(Math.random()-.5)*30)),r:5+Math.random()*5,color:'hsl('+Math.floor(Math.random()*360)+', 80%, 60%)'});} }
function distSq(a,b){var dx=a.x-b.x,dy=a.y-b.y;return dx*dx+dy*dy;}
function angleLerp(a,b,t){var d=b-a;while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;return a+d*t;}
function roundSeg(s){return{x:Math.round(s.x),y:Math.round(s.y)};}
function hasEffect(p,type){return p.effects[type]&&p.effects[type]>Date.now();}
function applyPowerup(p,type){var def=POWERUP_TYPES.find(function(t){return t.type===type;});if(!def)return;if(type==='shrink'){for(var oid in players){if(oid===p.id)continue;var o=players[oid];if(!o.alive||hasEffect(o,'shield'))continue;var rm=Math.floor(o.segments.length*.2);for(var i=0;i<rm&&o.segments.length>5;i++){o.segments.pop();o.score=Math.max(0,o.score-1);}}}else{p.effects[type]=Date.now()+def.duration;}}
function addScore(name,score){allTimeScores.push({name:name,score:score,time:Date.now()});allTimeScores.sort(function(a,b){return b.score-a.score;});if(allTimeScores.length>50)allTimeScores.length=50;}
function getTop(){return allTimeScores.slice(0,20).map(function(e){return{n:e.name,s:e.score};});}
function killPlayer(p,killer){p.alive=false;var fs=p.segments.length;dropFood(p.segments);addScore(p.name,fs);io.to(p.id).emit('dead',{killer:killer,score:fs,ranking:getTop()});}

// Physics
setInterval(function(){
  var now=Date.now();
  for(var id in players){
    var p=players[id];if(!p.alive)continue;
    p.angle=angleLerp(p.angle,p.targetAngle,.12);
    var speed=SPEED;if(p.boosting)speed=BOOST_SPEED;if(hasEffect(p,'speed'))speed*=1.5;
    if(p.boosting&&p.segments.length>5&&Math.random()<.15){var tail=p.segments.pop();food.push({x:tail.x,y:tail.y,r:4,color:'#888'});p.score=Math.max(0,p.score-2);}
    var head=p.segments[0],nh={x:head.x+Math.cos(p.angle)*speed,y:head.y+Math.sin(p.angle)*speed};
    if(nh.x<0||nh.x>WORLD_W||nh.y<0||nh.y>WORLD_H){if(hasEffect(p,'shield')){nh.x=Math.max(5,Math.min(WORLD_W-5,nh.x));nh.y=Math.max(5,Math.min(WORLD_H-5,nh.y));delete p.effects.shield;}else{killPlayer(p,null);continue;}}
    p.segments.unshift(nh);
    for(var si=1;si<p.segments.length;si++){var pv=p.segments[si-1],cu=p.segments[si],ds=distSq(pv,cu);if(ds>SEG_DIST_SQ){var d=Math.sqrt(ds),r=SEGMENT_DIST/d;cu.x=pv.x+(cu.x-pv.x)*r;cu.y=pv.y+(cu.y-pv.y)*r;}}
    if(p.segments.length>START_LENGTH+p.score)p.segments.pop();
    if(hasEffect(p,'magnet')){for(var mi=0;mi<food.length;mi++){var mf=food[mi],md=distSq(nh,mf);if(md<14400&&md>1){var dd=Math.sqrt(md);mf.x+=(nh.x-mf.x)/dd*2.5;mf.y+=(nh.y-mf.y)/dd*2.5;}}}
    var multi=hasEffect(p,'x2')?2:1;
    for(var fi=food.length-1;fi>=0;fi--){var f=food[fi],th=f.r+14;if(distSq(nh,f)<th*th){p.score+=FOOD_GROW*multi;food[fi]=spawnFood();}}
    for(var pi=powerups.length-1;pi>=0;pi--){var pw=powerups[pi];if(distSq(nh,pw)<(pw.r+14)*(pw.r+14)){applyPowerup(p,pw.type);io.to(id).emit('powerup',{type:pw.type});powerups[pi]=spawnPowerup();}}
    if(!hasEffect(p,'ghost')&&p.alive){var cr=16*16,died=false;
      for(var sci=15;sci<p.segments.length;sci++){if(distSq(nh,p.segments[sci])<cr){if(hasEffect(p,'shield')){delete p.effects.shield;}else{killPlayer(p,null);died=true;}break;}}
      if(!died){for(var oid in players){if(oid===id||died)continue;var o=players[oid];if(!o.alive)continue;for(var oci=5;oci<o.segments.length;oci++){if(distSq(nh,o.segments[oci])<cr){if(hasEffect(p,'shield')){delete p.effects.shield;}else{o.score+=Math.floor(p.segments.length/3);for(var oj=0;oj<Math.floor(p.segments.length/5);oj++){var last=o.segments[o.segments.length-1];o.segments.push({x:last.x,y:last.y});}killPlayer(p,o.name);died=true;}break;}}}}}
  }
  while(powerups.length<POWERUP_COUNT)powerups.push(spawnPowerup());
},1000/GAME_TPS);

// Network
setInterval(function(){
  var now=Date.now();
  var alive=Object.values(players).filter(function(p){return p.alive;});
  var lb=alive.sort(function(a,b){return b.segments.length-a.segments.length;}).slice(0,10).map(function(p){return{n:p.name,s:p.segments.length};});
  for(var id in players){
    var p=players[id];if(!p.alive)continue;
    var head=p.segments[0],vd=900,np={};
    for(var oid in players){var op=players[oid];if(!op.alive)continue;var oh=op.segments[0],ex=op.segments.length*SEGMENT_DIST;
      if(Math.abs(oh.x-head.x)<vd+ex&&Math.abs(oh.y-head.y)<vd+ex){var segs;if(op.segments.length>80){segs=[];var step=Math.max(2,Math.floor(op.segments.length/60));for(var i=0;i<op.segments.length;i+=step)segs.push(roundSeg(op.segments[i]));}else{segs=op.segments.map(roundSeg);}var fx=[];for(var k in op.effects){if(op.effects[k]>now)fx.push(k);}np[oid]={n:op.name,sk:op.skin,s:segs,b:op.boosting?1:0,fx:fx};}}
    var nf=[],npw=[];
    for(var fi=0;fi<food.length;fi++){var f=food[fi];if(Math.abs(f.x-head.x)<vd&&Math.abs(f.y-head.y)<vd)nf.push({x:Math.round(f.x),y:Math.round(f.y),r:Math.round(f.r),c:f.color});}
    for(var pi=0;pi<powerups.length;pi++){var pw=powerups[pi];if(Math.abs(pw.x-head.x)<vd&&Math.abs(pw.y-head.y)<vd)npw.push({x:Math.round(pw.x),y:Math.round(pw.y),r:pw.r,t:pw.type,c:pw.color,ic:pw.icon});}
    io.volatile.to(id).emit('s',{p:np,f:nf,pw:npw,i:id,sc:p.segments.length,lb:lb});
  }
},1000/NET_TPS);

// Sockets
io.on('connection',function(socket){
  socket.emit('ranking',getTop());
  socket.on('join',function(d){var name=(d.name||'Gusano').substring(0,15);var skin=typeof d.skin==='string'?d.skin.substring(0,50):'classic';players[socket.id]=createPlayer(socket.id,name,skin);});
  socket.on('input',function(d){var p=players[socket.id];if(!p||!p.alive)return;if(typeof d.angle==='number'&&isFinite(d.angle))p.targetAngle=d.angle;p.boosting=!!d.boost;});
  socket.on('respawn',function(d){var name=(d.name||'Gusano').substring(0,15);var skin=typeof d.skin==='string'?d.skin.substring(0,50):'classic';players[socket.id]=createPlayer(socket.id,name,skin);});
  socket.on('disconnect',function(){var p=players[socket.id];if(p&&p.alive)dropFood(p.segments);delete players[socket.id];});
});

};
