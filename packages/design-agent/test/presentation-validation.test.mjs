import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkHtmlBrowser } from '../dist/html-delivery.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(source, images, checks = []) {
  const run = await mkdtemp(join(tmpdir(), 'dreamatic-presentation-'));
  const files = [{ source: 'plan/html/demo/index.html', output: 'artifacts/demo/index.html' }];
  const resources = images.map(id => ({ source: `artifacts/${id}.png`, output: `artifacts/demo/images/${id}.png` }));
  for (const mapping of [...files, ...resources]) {
    await mkdir(dirname(join(run, mapping.output)), { recursive: true });
    await writeFile(join(run, mapping.output), mapping === files[0] ? source : png);
  }
  return { run, contract: { schemaVersion: 2,
    presentation: { mode: 'html', entry: files[0].output },
    deliverables: images.map(id => ({ id, file: `artifacts/${id}.png`, presentation: { required: true, access: 'embed' } })),
    tasks: [{ id: 'page', method: 'html_generate', files, resources, dependencies: images, interaction_checks: checks, viewports: [{ width: 1440, height: 900 }, { width: 390, height: 844 }] }],
  } };
}

test('publication recognizes delayed and scroll-revealed mapped images independently of interaction order', async () => {
  const source = `<!doctype html><html><head><title>Reveal</title><style>
    body{margin:0}img{display:block;width:180px;height:120px}section{height:1000px}
    @keyframes reveal{from{opacity:0}to{opacity:1}}
    .hero{opacity:0;animation:reveal .15s .15s forwards}
    .detail{opacity:0}.detail.shown{animation:reveal .15s forwards}
  </style></head><body><button id="home" onclick="window.scrollTo(0,0)">Home</button>
  <section><img class="hero" src="images/hero.png"></section>
  <section><img class="detail" src="images/detail.png" loading="lazy"></section>
  <section><img class="detail" src="images/joint.png" loading="lazy"></section>
  <script>const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{
    if(entry.isIntersecting){entry.target.classList.add('shown');observer.unobserve(entry.target)}
  }));document.querySelectorAll('.detail').forEach(node=>observer.observe(node));</script></body></html>`;
  const { run, contract } = await fixture(source, ['hero', 'detail', 'joint'], [{ name: 'Return home', steps: [{ action: 'click', selector: '#home' }] }]);
  try {
    const result = await checkHtmlBrowser(run, contract, undefined, { interactionsOnly: true, sourcePreview: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.passed, true, result.issues.join('\n'));
    assert.equal(result.checks.length, 2);
    assert.ok(result.checks.every(check => check.status === 'passed'));
  } finally { await rm(run, { recursive: true, force: true }); }
});

test('publication still rejects permanent hiding and missing references with actionable preview diagnostics', async () => {
  const { run, contract } = await fixture(`<!doctype html><html><head><title>Hidden</title><style>
    @keyframes pulse{from{opacity:.5}to{opacity:1}}body{animation:pulse 1s infinite}
  </style></head><body><div id="private" style="display:none"><img src="images/hidden.png"></div>
    <div id="transparent" style="opacity:0"><img src="images/transparent.png"></div></body></html>`, ['hidden', 'transparent', 'missing']);
  try {
    const result = await checkHtmlBrowser(run, contract, undefined, { interactionsOnly: true, sourcePreview: true });
    assert.equal(result.passed, false);
    assert.equal(result.issues.length, 6);
    assert.ok(result.issues.filter(issue => issue.includes('Presentation hidden:')).every(issue => issue.includes('div#private has display:none')));
    assert.ok(result.issues.filter(issue => issue.includes('Presentation transparent:')).every(issue => issue.includes('div#transparent has opacity:0')));
    assert.ok(result.issues.filter(issue => issue.includes('Presentation missing:')).every(issue => issue.includes('no matching embed reference')));
    assert.ok(result.issues.every(issue => issue.includes('Do not create artifact files')));
  } finally { await rm(run, { recursive: true, force: true }); }
});

test('viewport checks await smooth desktop and mobile navigation without changing the page', async () => {
  const source = `<!doctype html><html><head><title>Smooth navigation</title><style>
    body{margin:0}nav{position:fixed;top:0;background:white;z-index:2}#mobile,#toggle{display:none}
    #spacer{height:4000px}#target{height:1200px}
    @media(max-width:768px){#desktop{display:none}#toggle{display:block;position:fixed;top:0;z-index:3}#mobile.open{display:block;top:40px}}
  </style></head><body><button id="toggle" onclick="document.querySelector('#mobile').classList.toggle('open')">Menu</button>
    <nav id="desktop"><a href="#target">Target</a></nav><nav id="mobile"><a href="#target">Target</a></nav>
    <div id="spacer"></div><section id="target">Target</section><script>
    document.querySelectorAll('nav a').forEach(a=>a.addEventListener('click',e=>{
      e.preventDefault();document.querySelector('#mobile').classList.remove('open');
      setTimeout(()=>window.scrollTo({top:document.querySelector('#target').offsetTop-80,behavior:'smooth'}),150);
    }));</script></body></html>`;
  const { run, contract } = await fixture(source, [], [
    { name: 'Desktop arrival', viewport: { min_width: 769 }, steps: [{ action: 'click', selector: '#desktop a' }, { action: 'expect_in_viewport', selector: '#target' }] },
    { name: 'Mobile arrival', viewport: { max_width: 768 }, steps: [{ action: 'click', selector: '#toggle' }, { action: 'click', selector: '#mobile a' }, { action: 'expect_in_viewport', selector: '#target' }] },
  ]);
  contract.tasks[0].viewports.push({ width: 768, height: 900 });
  try {
    const result = await checkHtmlBrowser(run, contract);
    assert.equal(result.passed, true, result.issues.join('\n'));
    assert.equal(result.checks.filter(check => check.status === 'passed').length, 3);
  } finally { await rm(run, { recursive: true, force: true }); }
});

test('rendered offscreen content cannot satisfy navigation arrival when scrolling never occurs', async () => {
  const source = '<!doctype html><html><head><title>Broken navigation</title></head><body><a href="#target" onclick="event.preventDefault()">Target</a><div style="height:4000px"></div><section id="target">Target</section></body></html>';
  const { run, contract } = await fixture(source, [], [{ name: 'Arrival', steps: [{ action: 'click', selector: 'a' }, { action: 'expect_visible', selector: '#target' }, { action: 'expect_in_viewport', selector: '#target' }] }]);
  contract.tasks[0].viewports = [{ width: 1440, height: 900 }];
  try {
    const start = Date.now();
    const result = await checkHtmlBrowser(run, contract);
    assert.equal(result.passed, false);
    assert.match(result.issues.join('\n'), /step 3 expect_in_viewport.*outside the viewport after waiting 5000ms/);
    assert.ok(Date.now() - start < 12000, 'Failure must remain bounded');
  } finally { await rm(run, { recursive: true, force: true }); }
});

test('mobile navigation checks open the menu and match the inclusive CSS breakpoint', async () => {
  const source = `<!doctype html><html><head><title>Navigation</title><style>
    #toggle{display:none}@media(max-width:768px){nav{display:none}nav.open{display:block}#toggle{display:block}}
  </style></head><body><button id="toggle" onclick="document.querySelector('nav').classList.toggle('open')">Menu</button>
    <nav><a href="#systems">Systems</a></nav><section id="systems">Systems</section></body></html>`;
  const { run, contract } = await fixture(source, [], [
    { name: 'Desktop navigation', viewport: { min_width: 769 }, steps: [{ action: 'click', selector: 'nav a' }] },
    { name: 'Mobile navigation', viewport: { max_width: 768 }, steps: [{ action: 'click', selector: '#toggle' }, { action: 'click', selector: 'nav a' }, { action: 'expect_url', selector: 'body', value: '#systems' }] },
  ]);
  contract.tasks[0].viewports.push({ width: 768, height: 900 });
  try {
    const result = await checkHtmlBrowser(run, contract);
    assert.equal(result.passed, true, result.issues.join('\n'));
    assert.equal(result.checks.filter(check => check.status === 'passed').length, 3);
    assert.equal(result.checks.find(check => check.width === 768 && check.name === 'Mobile navigation').status, 'passed');
  } finally { await rm(run, { recursive: true, force: true }); }
});

test('scroll inspection preserves entry reachability and explicit download requirements', async () => {
  const { run, contract } = await fixture('<!doctype html><html><head><title>Entry</title></head><body>Entry</body></html>', ['detail']);
  try {
    const task = contract.tasks[0];
    const detail = { source: 'plan/html/demo/detail.html', output: 'artifacts/demo/detail.html' };
    task.files.push(detail);
    await writeFile(join(run, detail.output), '<!doctype html><html><head><title>Detail</title></head><body><img src="images/detail.png"></body></html>');
    let result = await checkHtmlBrowser(run, contract);
    assert.equal(result.passed, false);
    assert.ok(result.issues.every(issue => issue.includes('pages unreachable from entry')));
    await writeFile(join(run, task.files[0].output), '<!doctype html><html><head><title>Entry</title></head><body><a href="detail.html">Details</a></body></html>');
    result = await checkHtmlBrowser(run, contract);
    assert.equal(result.passed, true, result.issues.join('\n'));
    contract.deliverables[0].presentation.access = 'download';
    await writeFile(join(run, task.files[0].output), '<!doctype html><html><head><title>Entry</title></head><body><a href="images/detail.png">Image</a></body></html>');
    result = await checkHtmlBrowser(run, contract);
    assert.equal(result.passed, false);
    assert.ok(result.issues.every(issue => issue.includes('no matching download reference')));
    await writeFile(join(run, task.files[0].output), '<!doctype html><html><head><title>Entry</title></head><body><a href="images/detail.png" download>Download image</a></body></html>');
    result = await checkHtmlBrowser(run, contract);
    assert.equal(result.passed, true, result.issues.join('\n'));
  } finally { await rm(run, { recursive: true, force: true }); }
});
