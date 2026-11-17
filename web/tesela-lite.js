/*! tesela-lite.js · decodificador mínimo de imágenes Tesela (.tsl) para cualquier web
 *  https://github.com/davidpalmerojara/Tesela · MIT OR Apache-2.0
 *
 * Uso (copia tesela-lite.js y tesela-dec.wasm a la misma carpeta de tu web):
 *
 *   <script src="/tesela-lite.js" defer></script>
 *
 *   <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
 *        data-tsl="foto.tsl" data-fallback="foto.webp"
 *        width="1200" height="800" alt="Descripción" loading="lazy">
 *   <noscript><img src="foto.webp" width="1200" height="800" alt="Descripción"></noscript>
 *
 *   /* en tu CSS: sin JavaScript solo se ve la copia de <noscript> *\/
 *   @media (scripting: none) { img[data-tsl] { display: none !important } }
 *
 * - `src` es un marcador SVG vacío: sin él, un <img> sin imagen y con `alt`
 *   no respeta la proporción de width/height y la página salta al cargar.
 * - El .tsl se descarga y se decodifica en un Web Worker con tesela-dec.wasm
 *   (compilado una sola vez y compartido por todos los workers); el resultado
 *   se pone en el propio <img> como PNG (blob:), así que el CSS, `object-fit`,
 *   «Guardar imagen como» y los eventos load/error funcionan como siempre.
 * - `loading="lazy"`: se decodifica al acercarse a la pantalla.
 * - Si falla (sin WebAssembly, CSP, red, archivo dañado), se usa data-fallback;
 *   el respaldo solo se descarga en ese caso.
 * - Las animaciones .tsl muestran su primer fotograma (para animarlas: tesela.js).
 * - Las imágenes que se añaden después (galerías, etc.) se detectan solas.
 *
 * API: TeselaLite.decodeToURL(url) → Promise<string> (URL blob: de un PNG;
 * mismas URL, misma promesa), TeselaLite.load(img), TeselaLite.scan(raíz).
 * Opción: <script src="tesela-lite.js" data-wasm="otro.wasm"> (p. ej. el
 * tesela.wasm completo si la página ya lo usa).
 *
 * CSP mínima: script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
 * img-src 'self' data: blob:; connect-src 'self'.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Decodificación (la misma en el worker y, si no hay workers, en la página)

  /** Instancia el módulo; los imports de wasm-bindgen del módulo completo nunca se llaman. */
  function instantiate(module) {
    const imports = {};
    for (const imp of WebAssembly.Module.imports(module)) {
      (imports[imp.module] = imports[imp.module] || {})[imp.name] = function () {
        throw new Error('import inesperado: ' + imp.name);
      };
    }
    return WebAssembly.instantiate(module, imports).then(function (inst) {
      return inst.exports;
    });
  }

  /** .tsl (Uint8Array) → { width, height, rgba } con el ABI de src/wasm.rs. */
  function decodeWith(ex, bytes) {
    const ptr = ex.tsl_alloc(bytes.length);
    new Uint8Array(ex.memory.buffer).set(bytes, ptr);
    let out;
    try {
      out = ex.tsl_decode(ptr, bytes.length);
    } finally {
      ex.tsl_free(ptr, bytes.length);
    }
    const take = function (p) {
      const len = new DataView(ex.memory.buffer).getUint32(p, true);
      const data = new Uint8Array(ex.memory.buffer).slice(p + 4, p + len);
      ex.tsl_free(p, len);
      return data;
    };
    if (!out) throw new Error(new TextDecoder().decode(take(ex.tsl_last_error())) || 'error de Tesela');
    const body = take(out);
    const dv = new DataView(body.buffer);
    return { width: dv.getUint32(0, true), height: dv.getUint32(4, true), rgba: body.subarray(8) };
  }

  /** Perfil ICC del .tsl (sección de metadatos v2), o null. */
  function iccOf(bytes) {
    if (bytes.length < 27 || !(bytes[22] & 32) || bytes[22] & 64) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = Math.min(bytes.length, 27 + dv.getUint32(23, true));
    for (let p = 27; p + 8 <= end; ) {
      const n = dv.getUint32(p + 4, true);
      if (p + 8 + n > end) break;
      if (String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]) === 'ICCP') return bytes.subarray(p + 8, p + 8 + n);
      p += 8 + n;
    }
    return null;
  }

  let crcTable = null;
  function crc32(parts) {
    if (!crcTable) {
      crcTable = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c;
      }
    }
    let c = -1;
    for (const d of parts) for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32([out.subarray(4, 8 + data.length)]));
    return out;
  }

  /** zlib: comprimido con CompressionStream si existe; si no, bloques sin comprimir. */
  function zlib(raw) {
    if (typeof CompressionStream === 'function') {
      const s = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Response(s).arrayBuffer().then(function (b) {
        return new Uint8Array(b);
      });
    }
    const n = Math.max(1, Math.ceil(raw.length / 65535));
    const out = new Uint8Array(2 + raw.length + 5 * n + 4);
    out[0] = 0x78;
    out[1] = 0x01;
    let o = 2;
    for (let i = 0; i < n; i++) {
      const len = Math.min(65535, raw.length - i * 65535);
      out[o] = i === n - 1 ? 1 : 0;
      out[o + 1] = len & 255;
      out[o + 2] = len >>> 8;
      out[o + 3] = ~len & 255;
      out[o + 4] = (~len >>> 8) & 255;
      out.set(raw.subarray(i * 65535, i * 65535 + len), o + 5);
      o += 5 + len;
    }
    let a = 1;
    let b = 0;
    for (let i = 0; i < raw.length; ) {
      for (const end = Math.min(raw.length, i + 5552); i < end; i++) {
        a += raw[i];
        b += a;
      }
      a %= 65521;
      b %= 65521;
    }
    new DataView(out.buffer).setUint32(o, ((b << 16) | a) >>> 0);
    return Promise.resolve(out);
  }

  /** RGBA → PNG exacto (RGB si es opaco; filtro «Up»), con el perfil ICC si lo hay. */
  function toPng(img, icc) {
    const w = img.width;
    const h = img.height;
    const px = img.rgba;
    let opaque = true;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) {
        opaque = false;
        break;
      }
    }
    const ch = opaque ? 3 : 4;
    const stride = w * ch;
    const raw = new Uint8Array((stride + 1) * h);
    const row = new Uint8Array(stride);
    const prev = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
      for (let x = 0, s = y * w * 4; x < stride; x += ch, s += 4) {
        row[x] = px[s];
        row[x + 1] = px[s + 1];
        row[x + 2] = px[s + 2];
        if (ch === 4) row[x + 3] = px[s + 3];
      }
      const o = y * (stride + 1);
      raw[o] = 2;
      for (let x = 0; x < stride; x++) raw[o + 1 + x] = row[x] - prev[x];
      prev.set(row);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w);
    dv.setUint32(4, h);
    ihdr[8] = 8;
    ihdr[9] = opaque ? 2 : 6;
    const iccp = icc
      ? zlib(icc).then(function (z) {
          const d = new Uint8Array(5 + z.length);
          d.set([105, 99, 99, 0, 0]); // nombre «icc», nulo, método 0
          d.set(z, 5);
          return chunk('iCCP', d);
        })
      : Promise.resolve(null);
    return Promise.all([iccp, zlib(raw)]).then(function (r) {
      const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
      if (r[0]) parts.push(r[0]);
      parts.push(chunk('IDAT', r[1]), chunk('IEND', new Uint8Array(0)));
      return new Blob(parts, { type: 'image/png' });
    });
  }

  /** Descarga y decodifica un .tsl → Blob PNG. */
  function fetchAndDecode(ex, url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' en ' + url);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        const bytes = new Uint8Array(buf);
        if (bytes[0] !== 84 || bytes[1] !== 83 || bytes[2] !== 76) throw new Error('no es un archivo Tesela: ' + url);
        return toPng(decodeWith(ex, bytes), iccOf(bytes));
      });
  }

  // ---------------------------------------------------------------------------
  // Modo worker: este mismo archivo, cargado con new Worker(...)

  if (typeof document === 'undefined') {
    let ready = null;
    self.onmessage = function (ev) {
      const m = ev.data;
      if (m.module) {
        ready = instantiate(m.module);
        ready.then(
          function () {
            self.postMessage({ ready: true });
          },
          function (e) {
            self.postMessage({ ready: false, error: String(e) });
          },
        );
        return;
      }
      ready
        .then(function (ex) {
          return fetchAndDecode(ex, m.url);
        })
        .then(
          function (blob) {
            self.postMessage({ id: m.id, blob: blob });
          },
          function (e) {
            self.postMessage({ id: m.id, error: String((e && e.message) || e) });
          },
        );
    };
    return;
  }

  // ---------------------------------------------------------------------------
  // Modo página

  const script = document.currentScript;
  const scriptUrl = script ? script.src : location.href;
  const wasmUrl = new URL((script && script.dataset.wasm) || 'tesela-dec.wasm', scriptUrl).href;
  const supported = typeof WebAssembly === 'object' && typeof Blob === 'function' && typeof URL.createObjectURL === 'function';
  const maxWorkers = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

  let modulePromise = null;
  function compileFromBytes() {
    return fetch(wasmUrl)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' en ' + wasmUrl);
        return r.arrayBuffer();
      })
      .then(function (b) {
        return WebAssembly.compile(b);
      });
  }
  /** Compila tesela-dec.wasm una sola vez; los workers reciben el módulo ya compilado. */
  function getModule() {
    if (!modulePromise) {
      modulePromise = WebAssembly.compileStreaming
        ? WebAssembly.compileStreaming(fetch(wasmUrl)).catch(function (e) {
            // Servido sin Content-Type: application/wasm: se compila desde los bytes.
            if (e instanceof WebAssembly.CompileError) throw e;
            return compileFromBytes();
          })
        : compileFromBytes();
    }
    return modulePromise;
  }

  // Workers que comparten el módulo compilado. Si no se pueden crear (sin
  // Worker, script de otro origen o worker-src de la CSP), se decodifica aquí.
  const queue = [];
  const workers = [];
  const jobs = new Map();
  let nextId = 1;
  let noWorkers = typeof Worker !== 'function';
  let localExports = null;

  function runLocal(job) {
    if (!localExports) localExports = getModule().then(instantiate);
    localExports
      .then(function (ex) {
        return fetchAndDecode(ex, job.url);
      })
      .then(job.resolve, job.reject);
  }

  function failWorkers() {
    noWorkers = true;
    workers.forEach(function (w) {
      w.worker.terminate();
    });
    workers.length = 0;
    jobs.forEach(runLocal);
    jobs.clear();
    queue.splice(0).forEach(runLocal);
  }

  function spawn(module) {
    let w;
    try {
      w = { worker: new Worker(scriptUrl), ready: false, busy: 0 };
    } catch (e) {
      failWorkers();
      return;
    }
    w.worker.onmessage = function (ev) {
      const m = ev.data;
      if ('ready' in m) {
        if (!m.ready) return failWorkers();
        w.ready = true;
        return pump();
      }
      const job = jobs.get(m.id);
      jobs.delete(m.id);
      w.busy--;
      if (job) m.error ? job.reject(new Error(m.error)) : job.resolve(m.blob);
      pump();
    };
    w.worker.onerror = function (ev) {
      ev.preventDefault();
      failWorkers();
    };
    w.worker.postMessage({ module: module });
    workers.push(w);
  }

  function pump() {
    if (noWorkers) return queue.splice(0).forEach(runLocal);
    getModule().then(function (module) {
      while (queue.length) {
        const idle = workers.filter(function (w) {
          return w.ready && w.busy === 0;
        })[0];
        if (!idle) {
          if (workers.length < maxWorkers && !workers.some(function (w) { return !w.ready; })) spawn(module);
          if (noWorkers) return queue.splice(0).forEach(runLocal);
          return;
        }
        const job = queue.shift();
        const id = nextId++;
        jobs.set(id, job);
        idle.busy++;
        idle.worker.postMessage({ id: id, url: job.url });
      }
    }, function (e) {
      queue.splice(0).forEach(function (job) {
        job.reject(e);
      });
    });
  }

  const cache = new Map();

  /** Decodifica un .tsl y devuelve una URL blob: de un PNG (la misma para la misma URL). */
  function decodeToURL(url) {
    const abs = new URL(url, document.baseURI).href;
    let p = cache.get(abs);
    if (!p) {
      p = supported
        ? new Promise(function (resolve, reject) {
            queue.push({ url: abs, resolve: resolve, reject: reject });
            pump();
          }).then(function (blob) {
            return URL.createObjectURL(blob);
          })
        : Promise.reject(new Error('este navegador no tiene WebAssembly'));
      p.catch(function () {
        cache.delete(abs);
      });
      cache.set(abs, p);
    }
    return p;
  }

  const state = new WeakMap();

  /** Carga ya un <img data-tsl> (sin esperar a que se acerque a la pantalla). */
  function load(img) {
    const src = img.getAttribute('data-tsl');
    if (!src || state.get(img) === src) return Promise.resolve();
    state.set(img, src);
    return decodeToURL(src).then(
      function (url) {
        if (img.getAttribute('data-tsl') === src) img.src = url;
      },
      function (e) {
        const fb = img.getAttribute('data-fallback');
        if (img.getAttribute('data-tsl') !== src) return;
        if (fb) img.src = fb;
        if (typeof console !== 'undefined') console.warn('Tesela: ' + ((e && e.message) || e) + (fb ? ' (se usa ' + fb + ')' : ''));
      },
    );
  }

  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            io.unobserve(e.target);
            load(e.target);
          }
        });
      }, { rootMargin: '300px 0px' })
    : null;

  function handle(img) {
    if (state.get(img) === img.getAttribute('data-tsl')) return;
    if (!supported) {
      const fb = img.getAttribute('data-fallback');
      state.set(img, img.getAttribute('data-tsl'));
      if (fb) img.src = fb;
    } else if (io && img.getAttribute('loading') === 'lazy') {
      io.observe(img);
    } else {
      load(img);
    }
  }

  /** Busca <img data-tsl> en `root` (las que se añaden después se detectan solas). */
  function scan(root) {
    const r = root || document;
    if (r.matches && r.matches('img[data-tsl]')) handle(r);
    if (r.querySelectorAll) Array.prototype.forEach.call(r.querySelectorAll('img[data-tsl]'), handle);
  }

  window.TeselaLite = { decodeToURL: decodeToURL, load: load, scan: scan, supported: supported, wasm: wasmUrl };

  function start() {
    scan(document);
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function (records) {
        records.forEach(function (r) {
          if (r.type === 'attributes') handle(r.target);
          else Array.prototype.forEach.call(r.addedNodes, function (n) {
            if (n.nodeType === 1) scan(n);
          });
        });
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tsl'] });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
