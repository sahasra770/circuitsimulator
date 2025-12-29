const GRID_SIZE = 20;
const DT = 0.001; // Time step (1ms)
const MAX_HISTORY = 10000; // Increased to allow zooming out more
const G_MIN = 1e-9; // Small conductance to fix floating nodes

// --- STATE ---
let components = [];
let wires = [];
let nodes = []; 
let time = 0;
let isSimulating = false;
let selectedComponent = null;
let selectedWire = null;
let tool = 'select';
let isDragging = false;
let dragStart = null;
let tempWire = null;

// Graph Zoom/Pan State
let graphZoomX = 20; // Start zoomed in (10000 / 20 = 500 points visible)
let graphZoomY = 1;
let graphOffsetX = 0; // Index offset
let graphOffsetY = 0; // Value offset
let isGraphDragging = false;
let lastGraphMouse = { x: 0, y: 0 };

// Undo/Redo Stacks
let undoStack = [];
let redoStack = [];
let dragOriginState = null;

// Canvas setup
const canvas = document.getElementById('circuitCanvas');
const ctx = canvas.getContext('2d');
const graphCanvas = document.getElementById('graphCanvas');
const gCtx = graphCanvas.getContext('2d');

// --- UNDO / REDO SYSTEM ---

function serializeState() {
    const comps = components.map(c => ({
        type: c.type, 
        x: c.x, 
        y: c.y, 
        rotation: c.rotation, 
        value: c.value, 
        label: c.label, 
        id: c.id
    }));
    return JSON.stringify({ components: comps, wires: wires });
}

function saveState() {
    if (undoStack.length > 30) undoStack.shift();
    undoStack.push(serializeState());
    redoStack = [];
}

function restoreState(json) {
    const data = JSON.parse(json);
    wires = data.wires;
    
    components = data.components.map(d => {
        const c = new Component(d.type, d.x, d.y);
        c.id = d.id;
        c.rotation = d.rotation;
        c.value = d.value;
        c.label = d.label;
        return c;
    });
    
    selectedComponent = null;
    selectedWire = null;
    updatePropsPanel();
    
    analyzeCircuitStructure();
    draw();
    drawGraph();
}

function undo() {
    if (undoStack.length === 0) return;
    const current = serializeState();
    redoStack.push(current);
    const previous = undoStack.pop();
    restoreState(previous);
    showNotification("Undo");
}

function redo() {
    if (redoStack.length === 0) return;
    const current = serializeState();
    undoStack.push(current);
    const next = redoStack.pop();
    restoreState(next);
    showNotification("Redo");
}

// Keyboard Shortcuts
window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undo();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        redo();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelected();
    }
});

// --- GRAPH INTERACTION ---

graphCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const zoomFactor = 1.1;
    
    if (e.shiftKey) {
        // Vertical Zoom
        if (e.deltaY < 0) graphZoomY *= zoomFactor;
        else graphZoomY /= zoomFactor;
    } else {
        // Time Zoom
        if (e.deltaY < 0) graphZoomX *= zoomFactor;
        else graphZoomX /= zoomFactor;
        
        // Clamp zoom
        if (graphZoomX < 1) {
            graphZoomX = 1;
            graphOffsetX = 0;
        }
    }
    drawGraph();
}, { passive: false });

graphCanvas.addEventListener('mousedown', e => {
    isGraphDragging = true;
    lastGraphMouse = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mousemove', e => {
    if (isGraphDragging) {
        const dx = e.clientX - lastGraphMouse.x;
        const dy = e.clientY - lastGraphMouse.y;
        lastGraphMouse = { x: e.clientX, y: e.clientY };
        
        // Pan Time (Scale dx by zoom level)
        graphOffsetX += dx * (MAX_HISTORY / graphCanvas.width) / graphZoomX;
        
        // Pan Vertical
        graphOffsetY -= dy / graphZoomY; // Basic approximation
        
        drawGraph();
    }
});

window.addEventListener('mouseup', () => {
    isGraphDragging = false;
});

graphCanvas.addEventListener('dblclick', () => {
    // Reset view
    graphZoomX = 20;
    graphZoomY = 1;
    graphOffsetX = 0;
    graphOffsetY = 0;
    drawGraph();
    showNotification("Graph View Reset");
});


// --- COMPONENT CLASSES ---

class Component {
    constructor(type, x, y) {
        this.id = Math.random().toString(36).substr(2, 9);
        this.type = type;
        this.x = x;
        this.y = y;
        this.rotation = 0; // 0, 1, 2, 3 (x90 deg)
        this.value = 0;
        this.label = '';
        this.pins = []; 
        this.pinStatus = []; 
        this.history = { v: [], i: [], t: [] };
        this.nodeIds = [];
        
        this.prevV = 0;
        this.prevI = 0;
        
        if (type === 'resistor') { this.value = 1000; this.label = '1kΩ'; this.pins = [{x:-2,y:0}, {x:2,y:0}]; }
        else if (type === 'capacitor') { this.value = 0.00001; this.label = '10µF'; this.pins = [{x:-1,y:0}, {x:1,y:0}]; }
        else if (type === 'inductor') { this.value = 0.1; this.label = '100mH'; this.pins = [{x:-2,y:0}, {x:2,y:0}]; }
        else if (type === 'source') { this.value = 5; this.label = '5V'; this.pins = [{x:0,y:1}, {x:0,y:-1}]; } 
        else if (type === 'ground') { this.value = 0; this.label = 'GND'; this.pins = [{x:0,y:0}]; }
        
        this.pinStatus = new Array(this.pins.length).fill(false);
    }

    getPinCoords(index) {
        const p = this.pins[index];
        let rx = p.x, ry = p.y;
        if (this.rotation === 1) { rx = -p.y; ry = p.x; }
        else if (this.rotation === 2) { rx = -p.x; ry = -p.y; }
        else if (this.rotation === 3) { rx = p.y; ry = -p.x; }
        
        return {
            x: this.x + rx * GRID_SIZE,
            y: this.y + ry * GRID_SIZE
        };
    }

    isPointOver(mx, my) {
        const size = GRID_SIZE * 2;
        return mx >= this.x - size && mx <= this.x + size &&
               my >= this.y - size && my <= this.y + size;
    }
}

// --- INTERACTION ---

function resize() {
    const container = document.getElementById('canvas-container');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    
    const gContainer = document.querySelector('.graph-panel');
    graphCanvas.width = gContainer.clientWidth;
    graphCanvas.height = gContainer.clientHeight - 25;
    draw();
    drawGraph();
}
window.addEventListener('resize', resize);
setTimeout(resize, 100);

function setTool(t) {
    tool = t;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    const btn = Array.from(document.querySelectorAll('.tool-btn')).find(b => b.innerText.toLowerCase().includes(t) || (t==='source' && b.innerText.includes('Voltage')));
    if(btn) btn.classList.add('active');
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

function snap(val) { return Math.round(val / GRID_SIZE) * GRID_SIZE; }

function getDistanceToLineSegment(x, y, x1, y1, x2, y2) {
    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;
    const dot = A * C + B * D;
    const len_sq = C * C + D * D;
    let param = -1;
    if (len_sq !== 0) param = dot / len_sq;
    let xx, yy;
    if (param < 0) { xx = x1; yy = y1; } 
    else if (param > 1) { xx = x2; yy = y2; } 
    else { xx = x1 + param * C; yy = y1 + param * D; }
    const dx = x - xx;
    const dy = y - yy;
    return Math.sqrt(dx * dx + dy * dy);
}

canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const sx = snap(mx);
    const sy = snap(my);

    if (tool === 'select') {
        const comp = components.find(c => c.isPointOver(mx, my));
        if (comp) {
            selectedComponent = comp;
            selectedWire = null;
            isDragging = true;
            dragStart = { x: mx, y: my, cx: comp.x, cy: comp.y };
            dragOriginState = serializeState(); 
            updatePropsPanel();
            draw();
            drawGraph();
            return;
        }
        
        const wire = wires.find(w => getDistanceToLineSegment(mx, my, w.x1, w.y1, w.x2, w.y2) < 5);
        if (wire) {
            selectedWire = wire;
            selectedComponent = null;
            updatePropsPanel();
            draw();
            return;
        }

        selectedComponent = null;
        selectedWire = null;
        updatePropsPanel();
        draw();
        drawGraph();
    } else if (tool === 'wire') {
        isDragging = true;
        tempWire = { x1: sx, y1: sy, x2: sx, y2: sy };
    } else {
        saveState(); 
        const c = new Component(tool, sx, sy);
        components.push(c);
        setTool('select');
        draw();
        analyzeCircuitStructure();
    }
});

canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (isDragging) {
        if (tool === 'select' && selectedComponent) {
            const dx = mx - dragStart.x;
            const dy = my - dragStart.y;
            selectedComponent.x = snap(dragStart.cx + dx);
            selectedComponent.y = snap(dragStart.cy + dy);
        } else if (tool === 'wire' && tempWire) {
            tempWire.x2 = snap(mx);
            tempWire.y2 = snap(my);
        }
        draw();
    }
});

canvas.addEventListener('mouseup', e => {
    if (isDragging) {
        if (tool === 'wire' && tempWire) {
            if (tempWire.x1 !== tempWire.x2 || tempWire.y1 !== tempWire.y2) {
                saveState(); 
                wires.push({...tempWire});
            }
            tempWire = null;
            analyzeCircuitStructure();
        } else if (tool === 'select') {
            if (selectedComponent && dragStart && (selectedComponent.x !== dragStart.cx || selectedComponent.y !== dragStart.cy)) {
                 if (dragOriginState) {
                     undoStack.push(dragOriginState);
                     if (undoStack.length > 30) undoStack.shift();
                     redoStack = [];
                     dragOriginState = null;
                 }
            }
            analyzeCircuitStructure();
        }
    }
    isDragging = false;
    draw();
});

canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const comp = components.find(c => c.isPointOver(mx, my));
    if (comp) {
        saveState();
        comp.rotation = (comp.rotation + 1) % 4;
        analyzeCircuitStructure();
        draw();
    }
});

// --- SIMULATION ENGINE ---

function analyzeCircuitStructure() {
    let points = [];
    wires.forEach(w => {
        points.push({x:w.x1, y:w.y1, parent: null});
        points.push({x:w.x2, y:w.y2, parent: null});
    });
    
    const pinPointMap = new Map(); 
    components.forEach(c => {
        c.pins.forEach((p, i) => {
            const coord = c.getPinCoords(i);
            const pointObj = {x: coord.x, y: coord.y, parent: null};
            points.push(pointObj);
            pinPointMap.set(c.id + '_' + i, pointObj);
        });
    });

    const find = (p) => {
        if (p.parent === null) return p;
        p.parent = find(p.parent);
        return p.parent;
    };

    for(let i=0; i<points.length; i++) {
        for(let j=i+1; j<points.length; j++) {
            if(Math.abs(points[i].x - points[j].x) < 1 && Math.abs(points[i].y - points[j].y) < 1) {
                const rootA = find(points[i]);
                const rootB = find(points[j]);
                if(rootA !== rootB) rootA.parent = rootB;
            }
        }
    }

    wires.forEach((w, i) => {
        const p1 = points[2*i];
        const p2 = points[2*i+1];
        const rootA = find(p1);
        const rootB = find(p2);
        if(rootA !== rootB) rootA.parent = rootB;
    });

    const setCounts = new Map();
    points.forEach(p => {
        const root = find(p);
        setCounts.set(root, (setCounts.get(root) || 0) + 1);
    });
    
    components.forEach(c => {
        c.pinStatus = c.pins.map((p, i) => {
            const pointObj = pinPointMap.get(c.id + '_' + i);
            const root = find(pointObj);
            return (setCounts.get(root) || 0) > 1;
        });
    });

    let uniqueNodes = [];
    points.forEach(p => {
        const root = find(p);
        if (!uniqueNodes.includes(root)) uniqueNodes.push(root);
    });

    let groundedRoots = new Set();
    components.filter(c => c.type === 'ground').forEach(g => {
        const coord = g.getPinCoords(0);
        const p = points.find(pt => Math.abs(pt.x - coord.x) < 1 && Math.abs(pt.y - coord.y) < 1);
        if(p) groundedRoots.add(find(p));
    });

    nodes = [];
    let idxCounter = 1;
    uniqueNodes.forEach(n => {
        if (groundedRoots.has(n)) {
            n.id = 0;
        } else {
            n.id = idxCounter++;
        }
    });

    components.forEach(c => {
        c.nodeIds = [];
        c.pins.forEach((pin, i) => {
            const coord = c.getPinCoords(i);
            const p = points.find(pt => Math.abs(pt.x - coord.x) < 1 && Math.abs(pt.y - coord.y) < 1);
            if (p) {
                c.nodeIds.push(find(p).id);
            } else {
                c.nodeIds.push(-1);
            }
        });
    });
    
    return idxCounter - 1;
}

function solveMNA() {
    let vSourceComps = components.filter(c => c.type === 'source');
    let numNodes = 0;
    components.forEach(c => c.nodeIds.forEach(id => { if(id > numNodes) numNodes = id; }));
    
    let numVSources = vSourceComps.length;
    let size = numNodes + numVSources;
    let x = null;

    if (size > 0) {
        let A = Array(size).fill(0).map(() => Array(size).fill(0));
        let z = Array(size).fill(0);

        for(let i=0; i<numNodes; i++) A[i][i] += G_MIN;

        function addG(n1, n2, g) {
            let i1 = n1 - 1;
            let i2 = n2 - 1;
            if (n1 > 0) { A[i1][i1] += g; if (n2 > 0) A[i1][i2] -= g; }
            if (n2 > 0) { A[i2][i2] += g; if (n1 > 0) A[i2][i1] -= g; }
        }

        function addI(n, current) { if (n > 0) z[n-1] += current; }

        function addVStamp(n1, n2, vIdx, voltage) {
            let i1 = n1 - 1;
            let i2 = n2 - 1;
            let vRow = numNodes + vIdx;
            if (n1 > 0) { A[n1-1][vRow] += 1; A[vRow][n1-1] += 1; }
            if (n2 > 0) { A[n2-1][vRow] -= 1; A[vRow][n2-1] -= 1; }
            z[vRow] = voltage;
        }

        components.forEach(c => {
            if (c.type === 'ground') return;
            if (c.nodeIds.length < 2) return; 
            if (c.nodeIds.includes(-1)) return;

            let n1 = c.nodeIds[0];
            let n2 = c.nodeIds[1];
            
            if (c.type === 'resistor') {
                let g = 1 / c.value;
                addG(n1, n2, g);
            }
            else if (c.type === 'capacitor') {
                let g = c.value / DT;
                addG(n1, n2, g);
                let i_eq = g * c.prevV; 
                addI(n1, i_eq);
                addI(n2, -i_eq);
            }
            else if (c.type === 'inductor') {
                let g = DT / c.value;
                addG(n1, n2, g);
                let i_eq = c.prevI; 
                addI(n1, -i_eq);
                addI(n2, i_eq);
            }
        });
        
        vSourceComps.forEach((src, i) => {
            if (src.nodeIds.length >= 2 && !src.nodeIds.includes(-1)) {
                 addVStamp(src.nodeIds[0], src.nodeIds[1], i, src.value);
            }
        });

        x = gaussianElimination(A, z);
    }

    if (!x) x = new Array(size).fill(0);

    let nodeVoltages = [0];
    for(let i=0; i<numNodes; i++) nodeVoltages.push(x[i]);
    
    components.forEach(c => {
        let current = 0;
        let vDiff = 0;
        const isConnected = c.nodeIds.length >= 2 && !c.nodeIds.includes(-1);
        const isGround = c.type === 'ground';

        if (isGround) {
            vDiff = 0; current = 0;
        } else if (isConnected) {
            let v1 = nodeVoltages[c.nodeIds[0]] || 0;
            let v2 = nodeVoltages[c.nodeIds[1]] || 0;
            vDiff = v1 - v2;
            
            if (c.type === 'resistor') {
                current = vDiff / c.value;
            } else if (c.type === 'capacitor') {
                current = c.value * (vDiff - c.prevV) / DT;
                c.prevV = vDiff;
            } else if (c.type === 'inductor') {
                current = c.prevI + (DT/c.value) * vDiff;
                c.prevI = current;
                c.prevV = vDiff;
            } else if (c.type === 'source') {
                let idx = vSourceComps.indexOf(c);
                if (idx >= 0 && x.length > numNodes + idx) current = x[numNodes + idx]; 
                c.prevV = c.value;
            }
        } else {
            vDiff = 0; current = 0;
        }
        
        c.history.v.push(vDiff);
        c.history.i.push(current); // Amps
        c.history.t.push(time);
        
        if (c.history.v.length > MAX_HISTORY) {
            c.history.v.shift();
            c.history.i.shift();
            c.history.t.shift();
        }
    });
    
    time += DT;
}

function gaussianElimination(A, b) {
    let n = A.length;
    for (let i = 0; i < n; i++) {
        let maxEl = Math.abs(A[i][i]);
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(A[k][i]) > maxEl) { maxEl = Math.abs(A[k][i]); maxRow = k; }
        }
        if (Math.abs(maxEl) < 1e-12) return null; 
        let tmp = A[maxRow]; A[maxRow] = A[i]; A[i] = tmp;
        let t = b[maxRow]; b[maxRow] = b[i]; b[i] = t;
        for (let k = i + 1; k < n; k++) {
            let c = -A[k][i] / A[i][i];
            for (let j = i; j < n; j++) {
                if (i === j) A[k][j] = 0;
                else A[k][j] += c * A[i][j];
            }
            b[k] += c * b[i];
        }
    }
    let x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        let sum = 0;
        for (let j = i + 1; j < n; j++) { sum += A[i][j] * x[j]; }
        x[i] = (b[i] - sum) / A[i][i];
    }
    return x;
}

// --- RUNTIME & DRAWING ---

let simInterval;

function toggleSim() {
    const btn = document.getElementById('btn-sim');
    if (isSimulating) {
        isSimulating = false;
        clearInterval(simInterval);
        btn.innerText = "Start Simulation";
        btn.style.background = "";
    } else {
        if (!components.some(c => c.type === 'ground')) {
            showNotification("Error: Circuit needs a Ground (GND) component!");
            return;
        }
        analyzeCircuitStructure();
        isSimulating = true;
        simInterval = setInterval(() => {
            solveMNA();
            drawGraph();
        }, 10); 
        btn.innerText = "Stop Simulation";
        btn.style.background = "#c00";
        showNotification("Simulation Started.");
    }
}

function resetSim() {
    if (isSimulating) toggleSim();
    time = 0;
    components.forEach(c => {
        c.prevV = 0;
        c.prevI = 0;
        c.history = { v: [], i: [], t: [] };
    });
    drawGraph();
}

function showNotification(msg) {
    const el = document.getElementById('notification');
    el.innerText = msg;
    el.style.opacity = 1;
    setTimeout(() => el.style.opacity = 0, 3000);
}

function deleteSelected() {
    saveState(); 
    if (selectedComponent) {
        components = components.filter(c => c !== selectedComponent);
        selectedComponent = null;
        analyzeCircuitStructure();
        draw();
        updatePropsPanel();
    } else if (selectedWire) {
        wires = wires.filter(w => w !== selectedWire);
        selectedWire = null;
        analyzeCircuitStructure();
        draw();
        updatePropsPanel();
    }
}

function clearAll() {
    saveState();
    components = [];
    wires = [];
    selectedComponent = null;
    selectedWire = null;
    time = 0;
    analyzeCircuitStructure();
    draw();
    drawGraph();
    updatePropsPanel();
    showNotification("Circuit Cleared");
}

// DRAWING

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw Wires
    wires.forEach(w => {
        ctx.strokeStyle = (w === selectedWire) ? '#ffeb3b' : '#0f0'; // Yellow if selected
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(w.x1, w.y1);
        ctx.lineTo(w.x2, w.y2);
        ctx.stroke();
    });

    // Temp Wire
    if (tool === 'wire' && tempWire) {
        ctx.strokeStyle = '#666';
        ctx.beginPath();
        ctx.moveTo(tempWire.x1, tempWire.y1);
        ctx.lineTo(tempWire.x2, tempWire.y2);
        ctx.stroke();
    }

    // Draw Components
    components.forEach(c => {
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(c.rotation * Math.PI / 2);
        
        if (c === selectedComponent) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.fillRect(-25, -25, 50, 50);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.strokeRect(-25, -25, 50, 50);
        }
        
        ctx.strokeStyle = '#d4d4d4';
        ctx.lineWidth = 2;
        ctx.fillStyle = '#d4d4d4';

        ctx.beginPath();
        if (c.type === 'resistor') {
            ctx.moveTo(-40, 0); ctx.lineTo(-20, 0);
            ctx.lineTo(-15, -10); ctx.lineTo(-5, 10); ctx.lineTo(5, -10); ctx.lineTo(15, 10); ctx.lineTo(20, 0);
            ctx.lineTo(40, 0);
        } else if (c.type === 'capacitor') {
            ctx.moveTo(-20, 0); ctx.lineTo(-5, 0);
            ctx.moveTo(5, 0); ctx.lineTo(20, 0);
            ctx.moveTo(-5, -15); ctx.lineTo(-5, 15);
            ctx.moveTo(5, -15); ctx.lineTo(5, 15);
        } else if (c.type === 'inductor') {
            ctx.moveTo(-40, 0); ctx.lineTo(-20, 0);
            ctx.arc(-10, 0, 10, Math.PI, 0);
            ctx.arc(10, 0, 10, Math.PI, 0);
            ctx.moveTo(20, 0); ctx.lineTo(40, 0);
        } else if (c.type === 'source') {
            ctx.moveTo(0, -20); ctx.lineTo(0, -15);
            ctx.moveTo(0, 20); ctx.lineTo(0, 15);
            ctx.moveTo(-15, -5); ctx.lineTo(15, -5); 
            ctx.moveTo(-8, 5); ctx.lineTo(8, 5);   
            ctx.font = "10px Arial";
            ctx.fillStyle = "#aaa";
            ctx.fillText("+", 5, -10);
        } else if (c.type === 'ground') {
            ctx.moveTo(0, 0); ctx.lineTo(0, 10);
            ctx.moveTo(-10, 10); ctx.lineTo(10, 10);
            ctx.moveTo(-6, 14); ctx.lineTo(6, 14);
            ctx.moveTo(-2, 18); ctx.lineTo(2, 18);
        }
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = '#fff';
        ctx.font = '10px sans-serif';
        ctx.fillText(c.label, c.x - 10, c.y + 30);
    });
    
    // Connection Points (Visual Debugging)
    components.forEach(c => {
        c.pins.forEach((p,i) => {
            const pt = c.getPinCoords(i);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 3, 0, Math.PI*2);
            // RED = Open, GREEN = Connected
            ctx.fillStyle = (c.pinStatus && c.pinStatus[i]) ? '#00ff00' : '#ff0000';
            ctx.fill();
        });
    });
}

function drawGraph() {
    gCtx.fillStyle = '#252526';
    gCtx.fillRect(0, 0, graphCanvas.width, graphCanvas.height);
    
    if (selectedWire) {
        gCtx.fillStyle = '#666';
        gCtx.fillText("Wire Selected", 10, 20);
        return;
    }

    if (!selectedComponent || selectedComponent.history.v.length < 2) {
        gCtx.fillStyle = '#666';
        gCtx.fillText("No data or component selected", 10, 20);
        return;
    }
    
    const hist = selectedComponent.history;
    const w = graphCanvas.width;
    const h = graphCanvas.height;
    const pad = 30;
    
    // Zoom Logic
    const pointsToShow = Math.max(10, Math.floor(MAX_HISTORY / graphZoomX));
    const maxOffset = Math.max(0, hist.v.length - pointsToShow);
    let currentOffsetIndex = Math.round(graphOffsetX);
    if (currentOffsetIndex > maxOffset) currentOffsetIndex = maxOffset; 
    if (currentOffsetIndex < 0) currentOffsetIndex = 0; 
    
    const startIndex = Math.max(0, hist.v.length - pointsToShow - currentOffsetIndex);
    const endIndex = Math.max(0, hist.v.length - currentOffsetIndex);
    
    const visibleV = hist.v.slice(startIndex, endIndex);
    const visibleI = hist.i.slice(startIndex, endIndex);
    
    let minV = -5, maxV = 5; 
    let minI = -5, maxI = 5;

    if (visibleV.length > 0) {
        minV = Math.min(...visibleV); maxV = Math.max(...visibleV);
        minI = Math.min(...visibleI); maxI = Math.max(...visibleI);
    }
    
    // Vertical Zoom
    const rangeV = (maxV - minV) || 2;
    const midV = (maxV + minV) / 2;
    const zoomedRangeV = rangeV / graphZoomY;
    
    const rangeI = (maxI - minI) || 2e-9;
    const midI = (maxI + minI) / 2;
    const zoomedRangeI = rangeI / graphZoomY;
    
    const viewMinV = midV - (zoomedRangeV / 2) + graphOffsetY;
    const viewMaxV = midV + (zoomedRangeV / 2) + graphOffsetY;
    const viewMinI = midI - (zoomedRangeI / 2) + graphOffsetY * (rangeI/rangeV || 1e-9); 
    const viewMaxI = midI + (zoomedRangeI / 2) + graphOffsetY * (rangeI/rangeV || 1e-9);

    const xScale = (w - pad*2) / (pointsToShow - 1);
    
    // Grid
    gCtx.strokeStyle = '#333';
    gCtx.beginPath();
    gCtx.moveTo(pad, h/2); gCtx.lineTo(w-pad, h/2);
    gCtx.stroke();
    
    // Voltage (Cyan)
    if (visibleV.length > 1) {
        gCtx.strokeStyle = '#00bcd4';
        gCtx.lineWidth = 4;
        gCtx.beginPath();
        visibleV.forEach((v, i) => {
            const x = pad + i * xScale;
            const val = (v - viewMinV) / (viewMaxV - viewMinV);
            const y = h - pad - val * (h - 2*pad);
            if (i===0) gCtx.moveTo(x, y);
            else gCtx.lineTo(x, y);
        });
        gCtx.stroke();
    }
    
    // Current (Green)
    if (visibleI.length > 1) {
        gCtx.strokeStyle = '#4caf50';
        gCtx.lineWidth = 2;
        gCtx.beginPath();
        visibleI.forEach((curr, i) => {
            const x = pad + i * xScale;
            const val = (curr - viewMinI) / (viewMaxI - viewMinI);
            const y = h - pad - val * (h - 2*pad);
            if (i===0) gCtx.moveTo(x, y);
            else gCtx.lineTo(x, y);
        });
        gCtx.stroke();
    }
    
    // Stats & Labels
    gCtx.fillStyle = '#fff';
    gCtx.font = '12px monospace';
    
    const lastV = hist.v.length > 0 ? hist.v[hist.v.length-1] : 0;
    const lastI = hist.i.length > 0 ? hist.i[hist.i.length-1] : 0;
    const lastT = hist.t.length > 0 ? hist.t[hist.t.length-1] : 0;
    
    let iText = "";
    let absI = Math.abs(lastI);
    if (absI < 1e-6) iText = (lastI * 1e9).toFixed(2) + " nA";
    else if (absI < 1e-3) iText = (lastI * 1e6).toFixed(2) + " µA";
    else iText = (lastI * 1000).toFixed(2) + " mA";
    
    if (absI < 1e-12) iText = "0.00 mA";

    gCtx.fillText(`V: ${lastV.toFixed(2)}V`, 10, 15);
    gCtx.fillText(`I: ${iText}`, 10, 30);
    gCtx.fillText(`T: ${lastT.toFixed(3)}s`, 10, 45);
    
    // Zoom Indicators
    if (graphZoomX > 1.1 || graphZoomY > 1.1 || graphOffsetX > 10) {
        gCtx.fillStyle = '#ffeb3b';
        gCtx.fillText(`Zoom: ${graphZoomX.toFixed(1)}x`, w - 80, 15);
        gCtx.font = '10px sans-serif';
        gCtx.fillStyle = '#888';
        gCtx.fillText("(Dbl-Click Reset)", w - 90, 30);
    }
    
    document.getElementById('i-legend').innerText = `Current (${absI < 1e-6 ? 'nA' : absI < 1e-3 ? 'µA' : 'mA'})`;
}

// --- UI HELPERS ---

function updatePropsPanel() {
    const p = document.getElementById('props-content');
    
    if (selectedWire) {
        p.innerHTML = '<div style="color: #d4d4d4; font-size: 12px;"><strong>Wire Selected</strong><br><br>Length: ' + 
            Math.round(Math.sqrt(Math.pow(selectedWire.x2-selectedWire.x1, 2) + Math.pow(selectedWire.y2-selectedWire.y1, 2))) + 
            ' units</div>';
        document.getElementById('graph-label').innerText = "Wire Selection";
        return;
    }

    if (!selectedComponent) {
        p.innerHTML = '<div style="color: #666; font-size: 12px;">Select a component to edit values.</div>';
        document.getElementById('graph-label').innerText = "Component Trajectories";
        return;
    }
    
    const c = selectedComponent;
    document.getElementById('graph-label').innerText = `${c.type.toUpperCase()} Trajectories`;
    
    let html = `<div class="prop-row"><label>Type</label><input disabled value="${c.type}"></div>`;
    
    if (c.type !== 'wire' && c.type !== 'ground') {
        let unit = '';
        if (c.type === 'resistor') unit = 'Ω';
        if (c.type === 'capacitor') unit = 'F';
        if (c.type === 'inductor') unit = 'H';
        if (c.type === 'source') unit = 'V';
        
        html += `<div class="prop-row"><label>Value (${unit})</label>
                 <input type="number" step="any" value="${c.value}" onchange="changeVal(this.value)"></div>`;
    }
    
    html += `<div class="prop-row"><label>Label</label>
             <input type="text" value="${c.label}" onchange="changeLabel(this.value)"></div>`;
             
    p.innerHTML = html;
}

function changeVal(v) {
    if (selectedComponent) {
        saveState(); // Save BEFORE applying value change
        const val = parseFloat(v);
        if (!isNaN(val)) {
            selectedComponent.value = val;
            let suffix = '';
            if (selectedComponent.type === 'resistor') suffix = 'Ω';
            if (selectedComponent.type === 'source') suffix = 'V';
            if (selectedComponent.type === 'capacitor') suffix = 'F';
            if (selectedComponent.type === 'inductor') suffix = 'H';
            selectedComponent.label = v + suffix;
            analyzeCircuitStructure(); // Re-calc if needed
            draw();
        }
    }
}
function changeLabel(v) {
    if (selectedComponent) {
        saveState(); // Save BEFORE applying label change
        selectedComponent.label = v;
        draw();
    }
}

// Init
draw();