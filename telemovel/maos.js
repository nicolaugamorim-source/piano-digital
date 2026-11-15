// Reconhecimento das mãos (MediaPipe) num processo à parte: corre ao seu ritmo e nunca atrasa a câmara nem a deteção do toque.
// Worker "clássico" de propósito: o MediaPipe usa importScripts para carregar o motor, o que não funciona em workers de módulo.
'use strict';
const VER = '0.10.14';
const BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VER;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
let lm = null, failed = false, dev = '', FS = null, MP = null;
// Em alguns telemóveis a placa gráfica é mais lenta do que o processador dentro de um worker: mede os dois e fica com o mais rápido.
let nGpu = 0, msGpu = 0, nCpu = 0, msCpu = 0, cpuLm = null, phase = 'gpu';
async function makeCpu(){ try { cpuLm = await MP.HandLandmarker.createFromOptions(FS, { baseOptions:{ modelAssetPath:MODEL, delegate:'CPU' }, runningMode:'VIDEO', numHands:2,
  minHandDetectionConfidence:0.35, minHandPresenceConfidence:0.35, minTrackingConfidence:0.35 }); } catch(e){ cpuLm = null; } }
self.exports = {}; self.module = { exports:self.exports };
async function init(){
  try { importScripts(BASE + '/vision_bundle.cjs'); }
  catch(e){
    // se o servidor não marcar o ficheiro como script, carrega o texto e corre-o aqui
    try { const code = await (await fetch(BASE + '/vision_bundle.cjs')).text(); (0, eval)(code); }
    catch(e2){ failed = true; postMessage({ type:'error', msg:'sem ligação' }); return; }
  }
  const mp = self.module.exports && self.module.exports.HandLandmarker ? self.module.exports : self.exports;
  let fs;
  try { fs = await mp.FilesetResolver.forVisionTasks(BASE + '/wasm'); }
  catch(e){ failed = true; postMessage({ type:'error', msg:'motor' }); return; }
  let last = null;
  for (const delegate of ['GPU', 'CPU']){
    try {
      const opt = { baseOptions:{ modelAssetPath:MODEL, delegate }, runningMode:'VIDEO', numHands:2,
                    minHandDetectionConfidence:0.35, minHandPresenceConfidence:0.35, minTrackingConfidence:0.35 };
      if (delegate === 'GPU' && typeof OffscreenCanvas !== 'undefined') opt.canvas = new OffscreenCanvas(1, 1);
      lm = await mp.HandLandmarker.createFromOptions(fs, opt); dev = delegate; FS = fs; MP = mp;
      postMessage({ type:'ready', delegate }); return;
    } catch(e){ last = e; }
  }
  failed = true; postMessage({ type:'error', msg:'modelo' });
}
const ready = init();
let lastTs = 0;
onmessage = async e => {
  const { bmp, ts, t } = e.data;
  await ready;
  if (!lm){ try { bmp.close(); } catch(_){} postMessage({ type:'res', t, ms:0, hands:[] }); return; }
  const t0 = performance.now(); let hands = [];
  try {
    const st = Math.max(ts, lastTs + 1); lastTs = st;
    const use = phase === 'cpu' && cpuLm ? cpuLm : lm;
    const r = use.detectForVideo(bmp, st);
    hands = (r.landmarks || []).map(l => l.map(p => [p.x, p.y]));
  } catch(err){}
  const ms = performance.now() - t0;
  if (dev === 'GPU' && phase === 'gpu' && ++nGpu > 2){ msGpu += ms; if (nGpu === 8 && msGpu/6 > 45){ phase = 'mk'; await makeCpu(); phase = cpuLm ? 'cpu' : 'done'; } else if (nGpu === 8) phase = 'done'; }
  else if (phase === 'cpu' && ++nCpu > 2){ msCpu += ms; if (nCpu === 8){ if (msCpu < msGpu){ try { lm.close(); } catch(_){} lm = cpuLm; dev = 'CPU'; } else { try { cpuLm.close(); } catch(_){} } cpuLm = null; phase = 'done'; } }
  try { bmp.close(); } catch(_){}
  postMessage({ type:'res', t, ms, hands, delegate:(phase === 'cpu' ? 'CPU' : dev) });
};
