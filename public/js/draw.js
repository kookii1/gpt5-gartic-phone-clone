// drawing page: responsive square canvas, gray outside, zoom 50-200, flood-fill, bucket fixed
const params = parseHash();
const roomId = params.room || '';
const name = params.name || localStorage.getItem('gartic_name') || 'Player';

const holder = document.getElementById('canvasHolder');
const display = document.getElementById('display');
const backing = document.getElementById('backing');
const dctx = display.getContext('2d');
const bctx = backing.getContext('2d');

let logicalSize = 1200; // square canvas logical resolution (fits well, changeable)
backing.width = backing.height = logicalSize;
display.width = display.height = logicalSize; // we'll scale CSS to holder size

// scale CSS to fit holder responsively while keeping square aspect
function fitCanvas(){
  const rect = holder.getBoundingClientRect();
  const size = Math.min(rect.width, rect.height);
  display.style.width = size+'px';
  display.style.height = size+'px';
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// view transforms
let scale = 1.0; // min 0.5 max 2
let panX = 0, panY = 0;

// drawing state
let tool = 'brush';
let brushSize = 12;
let brushColor = '#000000';
let drawing = false;
let points = [];
const strokes = [];
const redoStack = [];

// UI elements
const btnBrush = document.getElementById('btnBrush');
const btnBucket = document.getElementById('btnBucket');
const btnEraser = document.getElementById('btnEraser');
const btnPicker = document.getElementById('btnPicker');
const sizeInput = document.getElementById('size');
const sizeVal = document.getElementById('sizeVal');
const colorInput = document.getElementById('color');
const zoomInput = document.getElementById('zoom');
const zoomVal = document.getElementById('zoomVal');
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const clearBtn = document.getElementById('clear');
const doneBtn = document.getElementById('done');

function setTool(t){
  tool = t;
  [btnBrush,btnBucket,btnEraser,btnPicker].forEach(b=>b.classList.remove('tool-active'));
  if(t==='brush') btnBrush.classList.add('tool-active');
  if(t==='bucket') btnBucket.classList.add('tool-active');
  if(t==='eraser') btnEraser.classList.add('tool-active');
  if(t==='pick') btnPicker.classList.add('tool-active');
}
btnBrush.onclick = ()=> setTool('brush');
btnBucket.onclick = ()=> setTool('bucket');
btnEraser.onclick = ()=> setTool('eraser');
btnPicker.onclick = ()=> setTool('pick');

sizeInput.addEventListener('input', ()=>{ brushSize = Number(sizeInput.value); sizeVal.textContent = brushSize; });
colorInput.addEventListener('input', ()=> brushColor = colorInput.value);
zoomInput.addEventListener('input', ()=>{ scale = Number(zoomInput.value)/100; zoomVal.textContent = zoomInput.value + '%'; drawAll(); });
zoomInput.min = 50; zoomInput.max = 200; // enforce 50%..200%

undoBtn.onclick = ()=>{ if(strokes.length) { redoStack.push(strokes.pop()); drawAll(); } };
redoBtn.onclick = ()=>{ if(redoStack.length){ strokes.push(redoStack.pop()); drawAll(); } };
clearBtn.onclick = ()=>{ strokes.length=0; redoStack.length=0; bctx.clearRect(0,0,logicalSize,logicalSize); drawAll(); };

doneBtn.onclick = ()=> {
  // send finish to server
  socket.emit('finish_drawing', { roomId }, (res)=> {
    location.href = '/prompt.html#room='+roomId+'&name='+encodeURIComponent(name);
  });
};

// convert client coords to world (logical)
function clientToWorld(cx, cy){
  const rect = display.getBoundingClientRect();
  const sx = (cx - rect.left);
  const sy = (cy - rect.top);
  const worldX = sx / (rect.width) * logicalSize / scale - panX;
  const worldY = sy / (rect.height) * logicalSize / scale - panY;
  return {x: Math.max(0, Math.min(logicalSize-1, worldX)), y: Math.max(0, Math.min(logicalSize-1, worldY))};
}

// draw helpers
function drawStrokeOnBacking(s){
  bctx.save();
  if(s.tool === 'eraser') {
    bctx.globalCompositeOperation = 'destination-out';
  } else {
    bctx.globalCompositeOperation = 'source-over';
  }
  bctx.lineCap = 'round';
  bctx.lineJoin = 'round';
  bctx.strokeStyle = s.color;
  bctx.lineWidth = s.size;
  const pts = s.points;
  if(pts.length===1){
    bctx.beginPath();
    bctx.arc(pts[0].x, pts[0].y, s.size/2, 0, Math.PI*2);
    bctx.fillStyle = s.color;
    bctx.fill();
  } else {
    bctx.beginPath();
    bctx.moveTo(pts[0].x, pts[0].y);
    for(let i=1;i<pts.length;i++) bctx.lineTo(pts[i].x, pts[i].y);
    bctx.stroke();
  }
  bctx.restore();
}

function drawAll(){
  // render backing to display with transforms
  dctx.save();
  dctx.clearRect(0,0,display.width,display.height);
  // center/fit backing onto display but apply pan/scale
  // We'll map backing logicalSize -> display CSS size (square). Use scale and pan:
  const cssSize = display.getBoundingClientRect().width;
  // draw backing scaled by (cssSize / logicalSize) * scale
  const factor = (cssSize / logicalSize) * scale;
  dctx.setTransform(factor,0,0,factor, (panX*factor), (panY*factor) );
  dctx.drawImage(backing, 0, 0);
  dctx.setTransform(1,0,0,1,0,0);
  dctx.restore();
}

// flood fill (scanline) optimized
function hexToRGB(hex){
  hex = hex.replace('#','');
  return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
}
function colorsMatch(img, idx, r,g,b,a){
  return img.data[idx]===r && img.data[idx+1]===g && img.data[idx+2]===b && img.data[idx+3]===a;
}
function bucketFillAt(x,y, fillColor){
  const img = bctx.getImageData(0,0, logicalSize, logicalSize);
  const w = img.width, h = img.height;
  const sx = Math.floor(x), sy = Math.floor(y);
  const startIdx = (sy*w + sx)*4;
  const sr = img.data[startIdx], sg = img.data[startIdx+1], sb = img.data[startIdx+2], sa = img.data[startIdx+3];
  const [fr,fg,fb] = hexToRGB(fillColor);
  if(sr===fr && sg===fg && sb===fb) return;
  const stack = [[sx,sy]];
  while(stack.length){
    const [cx,cy] = stack.pop();
    let px = cx;
    // move left
    while(px>=0){
      const idx = (cy*w + px)*4;
      if(!colorsMatch(img, idx, sr,sg,sb,sa)) break;
      px--;
    }
    px++;
    let spanUp=false, spanDown=false;
    while(px<w){
      const idx = (cy*w + px)*4;
      if(!colorsMatch(img, idx, sr,sg,sb,sa)) break;
      // set pixel
      img.data[idx]=fr; img.data[idx+1]=fg; img.data[idx+2]=fb; img.data[idx+3]=255;
      if(!spanUp && cy>0){
        const idxUp = ((cy-1)*w + px)*4;
        if(colorsMatch(img, idxUp, sr,sg,sb,sa)){ stack.push([px,cy-1]); spanUp=true; }
      } else if(spanUp && cy>0){
        const idxUp = ((cy-1)*w + px)*4;
        if(!colorsMatch(img, idxUp, sr,sg,sb,sa)) spanUp=false;
      }
      if(!spanDown && cy<h-1){
        const idxDown = ((cy+1)*w + px)*4;
        if(colorsMatch(img, idxDown, sr,sg,sb,sa)){ stack.push([px,cy+1]); spanDown=true; }
      } else if(spanDown && cy<h-1){
        const idxDown = ((cy+1)*w + px)*4;
        if(!colorsMatch(img, idxDown, sr,sg,sb,sa)) spanDown=false;
      }
      px++;
    }
  }
  bctx.putImageData(img,0,0);
}

// pointer events for drawing and bucket
let isSpaceDown = false;
let lastClient = null;
display.addEventListener('pointerdown', e=>{
  const p = clientToWorld(e.clientX, e.clientY);
  if(tool==='bucket'){
    bucketFillAt(p.x,p.y, brushColor);
    strokes.push({tool:'bucket', color:brushColor, size:0, points:[{x:p.x,y:p.y}]});
    drawAll();
    // send to server option: emit drawing_event with type bucket (not done here for brevity)
    return;
  }
  if(tool==='pick'){
    const pixel = bctx.getImageData(Math.floor(p.x), Math.floor(p.y), 1,1).data;
    const hex = '#'+[pixel[0],pixel[1],pixel[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
    brushColor = hex; colorInput.value = hex; setTool('brush');
    return;
  }
  if(tool==='brush' || tool==='eraser'){
    drawing = true;
    points = [{x:p.x,y:p.y}];
    lastClient = {x:e.clientX, y:e.clientY};
  }
});
display.addEventListener('pointermove', e=>{
  if(!drawing) return;
  const p = clientToWorld(e.clientX, e.clientY);
  const last = points[points.length-1];
  if(Math.hypot(p.x-last.x, p.y-last.y) > 0.5){
    points.push(p);
    // draw segment live on backing
    const s = {tool: tool, color: brushColor, size: brushSize, points: points.slice(-2)};
    drawStrokeOnBacking({tool: s.tool, color: s.color, size: s.size, points: s.points});
    drawAll();
  }
});
display.addEventListener('pointerup', e=>{
  if(!drawing) return;
  drawing = false;
  const s = {tool:tool, color:brushColor, size:brushSize, points: points.slice()};
  strokes.push(s);
  // persist stroke already drawn onto backing; for simplicity we already drew segments; now replay full stroke to ensure continuity
  drawStrokeOnBacking(s);
  drawAll();
});

// keyboard undo/redo
window.addEventListener('keydown', (e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z'){ if(strokes.length){ redoStack.push(strokes.pop()); // rebuild backing
      bctx.clearRect(0,0,logicalSize,logicalSize); strokes.forEach(s=>drawStrokeOnBacking(s)); drawAll(); } }
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='y'){ if(redoStack.length){ strokes.push(redoStack.pop()); bctx.clearRect(0,0,logicalSize,logicalSize); strokes.forEach(s=>drawStrokeOnBacking(s)); drawAll(); } }
});

// init: attach to room and handle server messages (minimal)
socket.emit('join_room', { roomId, name }, (res)=>{});
socket.on('phase_drawing', (data)=>{ console.log('drawing started', data); });
// other socket handlers can be added to receive events for live multiplayer

// initial drawAll
drawAll();
