/**
 * On-device perf journal for hunting the boot freeze: enabled with
 * ?svipeDebug=1 (or localStorage svipe_debug=1). Shows main-thread long
 * tasks (>50ms) and svipe lifecycle marks in a screenshot-able overlay —
 * mobile users can't open a devtools console.
 */
const enabled = typeof location !== 'undefined' &&
  (location.search.includes('svipeDebug=1') || localStorage.getItem('svipe_debug') === '1');

let box: HTMLDivElement | undefined;
const lines: string[] = [];
const t0 = performance.now();

function ensureBox() {
  if(box || !enabled) return;
  box = document.createElement('div');
  box.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
    'background:rgba(0,0,0,.82)', 'color:#7CFC00', 'font:10px/1.35 monospace',
    'padding:4px 6px', 'pointer-events:none', 'white-space:pre-wrap',
    'max-height:45vh', 'overflow:hidden'
  ].join(';');
  document.body.append(box);
}

function push(line: string) {
  lines.push(line);
  if(lines.length > 26) lines.shift();
  ensureBox();
  if(box) box.textContent = lines.join('\n');
}

export function svipeDebugLog(msg: string) {
  if(!enabled) return;
  push(`+${((performance.now() - t0) / 1000).toFixed(2)}s ${msg}`);
}

if(enabled) {
  svipeDebugLog('debug overlay on');

  try {
    const po = new PerformanceObserver((list) => {
      for(const e of list.getEntries()) {
        const attr = (e as any).attribution?.[0];
        const src = attr ? `${attr.containerType || ''} ${attr.containerSrc || attr.containerName || ''}`.trim() : '';
        push(`+${(e.startTime / 1000).toFixed(2)}s LONGTASK ${Math.round(e.duration)}ms ${src}`);
      }
    });
    po.observe({type: 'longtask', buffered: true});
  } catch(e) {}

  // Did taps reach the page at all? (captures every pointerdown globally)
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    const tab = t.closest?.('.svipe-tabbar__tab') as HTMLElement;
    if(tab) svipeDebugLog(`tap tab: ${tab.getAttribute('aria-label')}`);
  }, {capture: true, passive: true});
}

export default svipeDebugLog;
