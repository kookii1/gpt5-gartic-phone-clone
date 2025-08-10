// Simple game + signaling server for Gartic-like (classic mode)
// Run: npm install && node index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// serve static public folder
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const rooms = {}; // roomId -> { id, hostId, players: {sockId: {name, id}}, settings, gameState }

function makeRoom() {
  return nanoid(7);
}

function ensureRoom(roomId){
  if(!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      hostId: null,
      players: {},
      // default settings:
      settings: { rounds: 3, drawTimeSec: 60 },
      // game state for classic mode:
      game: {
        started: false,
        phase: null,
        roundIndex: 0,
        // sequence: array of chains per player (each chain entry will be {type:'prompt'|'drawing'|'description', data:...})
        sequences: {} // playerId -> [stageObj,...]
      }
    };
  }
  return rooms[roomId];
}

io.on('connection', socket => {
  console.log('conn', socket.id);

  socket.on('create_room', ({name}, cb) => {
    const id = makeRoom();
    ensureRoom(id);
    socket.join(id);
    const r = rooms[id];
    r.hostId = socket.id;
    r.players[socket.id] = { name: name || 'Player', id: socket.id };
    socket.data.roomId = id;
    socket.data.name = name;
    io.to(id).emit('room_update', r);
    cb && cb({ok:true,roomId:id});
  });

  socket.on('join_room', ({roomId, name}, cb) => {
    if(!rooms[roomId]) return cb && cb({ok:false,err:'no room'});
    socket.join(roomId);
    const r = rooms[roomId];
    r.players[socket.id] = { name: name || 'Player', id: socket.id };
    socket.data.roomId = roomId;
    socket.data.name = name;
    if(!r.hostId) r.hostId = socket.id;
    io.to(roomId).emit('room_update', r);
    cb && cb({ok:true, roomId});
  });

  socket.on('leave_room', () => {
    const roomId = socket.data.roomId;
    if(!roomId) return;
    const r = rooms[roomId];
    if(r){
      delete r.players[socket.id];
      if(r.hostId === socket.id){
        r.hostId = Object.keys(r.players)[0] || null;
      }
      io.to(roomId).emit('room_update', r);
    }
    socket.leave(roomId);
    delete socket.data.roomId;
  });

  socket.on('update_settings', ({roomId, settings}) => {
    if(!rooms[roomId]) return;
    const r = rooms[roomId];
    if(socket.id !== r.hostId) return;
    r.settings = Object.assign(r.settings, settings);
    io.to(roomId).emit('room_update', r);
  });

  // host starts classic game
  socket.on('start_game', ({roomId}, cb) => {
    const r = rooms[roomId];
    if(!r) return;
    if(socket.id !== r.hostId) return;
    // initialize sequences: for classic mode, each player starts with their prompt
    r.game.started = true;
    r.game.phase = 'collect_prompts';
    r.game.roundIndex = 0;
    r.game.sequences = {};
    // create sequence entry array for each player
    Object.values(r.players).forEach(p => {
      r.game.sequences[p.id] = [{ type:'prompt', from: p.id, data: null }]; // first slot prompt by themself
    });
    io.to(roomId).emit('game_started', {settings: r.settings});
    io.to(roomId).emit('game_phase', r.game);
    cb && cb({ok:true});
  });

  // a player submits their initial prompt
  socket.on('submit_prompt', ({roomId, prompt}, cb) => {
    const r = rooms[roomId]; if(!r) return;
    if(r.game.phase !== 'collect_prompts') return;
    // store prompt in sequences (their own sequence first item)
    if(!r.game.sequences[socket.id]) return;
    r.game.sequences[socket.id][0].data = prompt;
    // check if all prompts submitted
    const all = Object.keys(r.players).every(pid => r.game.sequences[pid][0].data);
    if(all){
      // move to drawing phase: distribute prompts to receivers according to classic mode rotation
      r.game.phase = 'drawing';
      r.game.roundIndex = 0;
      // For classic mode: each player receives a prompt from previous player (or shuffle). We rotate by 1 for simplicity.
      const ids = Object.keys(r.players);
      const n = ids.length;
      // create a mapping: receiver -> prompt to draw
      const mapping = {};
      ids.forEach((pid, i) => {
        const from = ids[(i+1)%n]; // prompt from next player in list
        mapping[pid] = { prompt: r.game.sequences[from][0].data, fromName: r.players[from].name, fromId: from };
      });
      // save mapping as current targets in r.game
      r.game.currentTargets = mapping;
      io.to(roomId).emit('phase_drawing', { mapping, settings: r.settings });
      // start draw timer (server not strictly enforcing drawing, but emits tick)
      startRoundTimer(roomId);
    }
    cb && cb({ok:true});
  });

  // drawing events relayed & saved: we expect events from client: stroke_begin, stroke_point, stroke_end, bucket, undo, clear
  socket.on('drawing_event', ({roomId, targetId, ev}) => {
    // broadcast to the single recipient (targetId), and also save to game state for reveal
    // Here clients will send targetId (the player that should draw this prompt) — server can also compute
    io.to(targetId).emit('drawing_event', {from: socket.id, ev});
    // persist if stroke_end or bucket/clear to r.game.sequences for reveal.
    const r = rooms[roomId]; if(!r) return;
    // keep a per-target drawing array: r.game.savedDrawings[targetId] = ...
    r.game.savedDrawings = r.game.savedDrawings || {};
    if(!r.game.savedDrawings[targetId]) r.game.savedDrawings[targetId] = [];
    if(ev.type === 'stroke_end' || ev.type === 'bucket' || ev.type === 'clear'){
      r.game.savedDrawings[targetId].push(ev);
    }
  });

  // After a drawing phase, clients will call finish_drawing for their round
  socket.on('finish_drawing', ({roomId}, cb) => {
    const r = rooms[roomId]; if(!r) return;
    // Mark player as finished. When all finished, go to description phase for next step.
    r.game.done = r.game.done || {};
    r.game.done[socket.id] = true;
    const allDone = Object.keys(r.players).every(pid => r.game.done[pid]);
    if(allDone){
      r.game.phase = 'describe';
      r.game.done = {};
      // Prepare which drawing each player should describe: in classic rotate, each player describes a drawing they received
      // We'll set r.game.toDescribe[pid] = drawingData (could be vector events saved above)
      r.game.toDescribe = {};
      Object.keys(r.players).forEach(pid => {
        // the drawing produced for pid is saved at r.game.savedDrawings[pid]
        r.game.toDescribe[pid] = r.game.savedDrawings && r.game.savedDrawings[pid] ? r.game.savedDrawings[pid] : [];
      });
      io.to(roomId).emit('phase_describe', { toDescribe: r.game.toDescribe });
    }
    cb && cb({ok:true});
  });

  // description submit
  socket.on('submit_description', ({roomId, text}, cb) => {
    const r = rooms[roomId]; if(!r) return;
    r.game.descriptions = r.game.descriptions || {};
    r.game.descriptions[socket.id] = text;
    const all = Object.keys(r.players).every(pid => r.game.descriptions && r.game.descriptions[pid]);
    if(all){
      // Advance rounds or finish game. For simplicity we finish and reveal everyone sequence as: prompt->drawing->description
      r.game.phase = 'reveal';
      // build reveal chains for each starting player (we can combine: prompt -> drawing by rotated player -> description by rotated player)
      const reveal = {};
      Object.keys(r.players).forEach(pid => {
        // prompt from pid is r.game.sequences[pid][0].data
        const prompt = r.game.sequences[pid][0].data;
        // drawing for recipient: who drew pid's prompt? In mapping earlier we used mapping[recipient].prompt was from some 'from', so invert:
        // find recipient who had prompt === prompt
        let drawingOwner = null;
        if(r.game.currentTargets){
          for(const rec in r.game.currentTargets){
            if(r.game.currentTargets[rec].prompt === prompt){
              drawingOwner = rec; break;
            }
          }
        }
        const drawingEvents = r.game.savedDrawings && r.game.savedDrawings[drawingOwner] ? r.game.savedDrawings[drawingOwner] : [];
        const descriptionFrom = drawingOwner; // the describer
        const descriptionText = r.game.descriptions && r.game.descriptions[descriptionFrom] ? r.game.descriptions[descriptionFrom] : '';
        reveal[pid] = { prompt, drawingOwner, drawingEvents, descriptionText };
      });
      io.to(roomId).emit('game_reveal', { reveal });
    }
    cb && cb({ok:true});
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if(roomId && rooms[roomId]){
      delete rooms[roomId].players[socket.id];
      if(rooms[roomId].hostId === socket.id){
        rooms[roomId].hostId = Object.keys(rooms[roomId].players)[0] || null;
      }
      io.to(roomId).emit('room_update', rooms[roomId]);
    }
  });

});

// minimal interval timer (not robust)
function startRoundTimer(roomId){
  const r = rooms[roomId];
  if(!r) return;
  const secs = r.settings.drawTimeSec || 60;
  let t = secs;
  const iv = setInterval(()=>{
    io.to(roomId).emit('tick', {t});
    t--;
    if(t<0){
      clearInterval(iv);
      io.to(roomId).emit('round_timeout');
      // optionally mark done for everyone
    }
  }, 1000);
}

server.listen(PORT, ()=> console.log('server listening on', PORT));
